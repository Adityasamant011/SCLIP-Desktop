import http from 'node:http'
import fs from 'node:fs'
import path from 'node:path'
import { spawn } from 'node:child_process'
import { webkit, chromium } from 'playwright'

const SCRATCH_DIR = '/Users/adityasamant/.gemini/antigravity/brain/89f99ce6-d8b2-4526-8a8d-0a3ad66ef880/scratch'
const DIST_DIR = '/Users/adityasamant/SCLIP/freecut/dist'

const MEDIA_1080P30 = path.join(SCRATCH_DIR, 'standard_1080p30_60s.mp4')
const MEDIA_SPEECH = path.join(SCRATCH_DIR, 'raw_speech_lecture.mp4')

// Create a standalone HTML page for testing the playback pipeline with exact metrics
const BENCHMARK_HTML = `<!doctype html>
<html>
<head>
  <meta charset="utf-8">
  <title>SCLIP Playback Performance Profiler</title>
  <style>
    body { background: #0b0b0c; color: #fff; font-family: monospace; margin: 0; padding: 20px; }
    #stage-container { width: 960px; height: 540px; position: relative; background: #000; border: 1px solid #333; margin-bottom: 20px; overflow: hidden; }
    video { width: 100%; height: 100%; object-fit: contain; position: absolute; top: 0; left: 0; }
    #metrics-display { font-size: 12px; line-height: 1.5; white-space: pre-wrap; background: #18181b; padding: 15px; border-radius: 8px; border: 1px solid #27272a; }
  </style>
</head>
<body>
  <h1>SCLIP Playback Benchmark Stage</h1>
  <div id="stage-container">
    <div id="video-mount"></div>
    <canvas id="overlay-canvas" width="1920" height="1080" style="position:absolute;top:0;left:0;width:100%;height:100%;display:none;pointer-events:none;"></canvas>
  </div>
  <div id="metrics-display">Initializing...</div>

  <script type="module">
    import { createClock } from '/src/runtime/player/clock/Clock.ts';
    import { usePlaybackStore } from '/src/shared/state/playback/store.ts';
    import { getVideoTargetTimeSeconds } from '/src/runtime/composition-runtime/utils/video-timing.ts';
    import { applyVideoElementAudioState } from '/src/runtime/composition-runtime/components/video-audio-context.ts';
    import { getSharedPreviewAudioContext } from '/src/runtime/composition-runtime/utils/preview-audio-graph.ts';
    import { getRealtimePreviewRenderSize } from '/src/features/preview/utils/preview-render-size.ts';
    
    window.__BENCHMARK_ENGINE__ = {
      clock: null,
      videoElement: null,
      audioContext: null,
      scenario: null,
      profiler: {
        recording: false,
        startTime: 0,
        endTime: 0,
        rafTimestamps: [],
        clockTicks: [],
        zustandDispatches: 0,
        longTasks: [],
        driftSamples: [],
        rvfcSamples: [],
        reactRenderEstimates: 0,
        stalls: 0,
      },
      
      init(scenario) {
        this.scenario = scenario;
        const fps = scenario.fps || 30;
        const totalFrames = scenario.durationInFrames || 1800;
        
        // 1. Initialize Clock
        this.clock = createClock({
          fps,
          durationInFrames: totalFrames,
          initialFrame: 0,
          loop: false,
        });
        
        // 2. Setup AudioContext if audio enabled
        if (scenario.hasAudio) {
          const ctx = getSharedPreviewAudioContext();
          if (ctx) {
            this.audioContext = ctx;
            this.clock.setAudioContext(ctx);
          }
        }
        
        // 3. Mount Video Element
        const mount = document.getElementById('video-mount');
        mount.innerHTML = '';
        const video = document.createElement('video');
        video.src = scenario.mediaUrl;
        video.playsInline = true;
        video.preload = 'auto';
        video.muted = !scenario.hasAudio;
        mount.appendChild(video);
        this.videoElement = video;
        
        if (scenario.hasAudio) {
          applyVideoElementAudioState(video, 1, []);
        }
        
        // Apply transform/effects styles if requested
        if (scenario.transform) {
          video.style.transform = \`scale(\${scenario.transform.scale || 1}) rotate(\${scenario.transform.rotation || 0}deg)\`;
          video.style.opacity = String(scenario.transform.opacity ?? 1);
        }
        if (scenario.hasEffects) {
          video.style.filter = 'brightness(1.15) contrast(1.1)';
        }
        
        // 4. Setup Long Task Observer
        if (typeof PerformanceObserver !== 'undefined') {
          try {
            const observer = new PerformanceObserver((list) => {
              if (!this.profiler.recording) return;
              for (const entry of list.getEntries()) {
                this.profiler.longTasks.push({
                  startTime: entry.startTime,
                  duration: entry.duration,
                });
              }
            });
            observer.observe({ entryTypes: ['longtask'] });
          } catch(e) {}
        }
        
        // 5. Connect Clock framechange to simulated full component pipeline
        this.clock.addEventListener('framechange', (frame) => {
          if (!this.profiler.recording) return;
          const now = performance.now();
          this.profiler.clockTicks.push({ frame, ts: now });
          
          // Simulate Zustand mutation on every frame (the exact production path)
          this.profiler.zustandDispatches += 1;
          usePlaybackStore.getState().setCurrentFrame(frame);
          
          // Measure drift
          if (video && !video.paused) {
            const targetTime = getVideoTargetTimeSeconds(0, fps, frame, 1, fps, 0, false);
            const drift = (video.currentTime - targetTime) * 1000;
            this.profiler.driftSamples.push({
              frame,
              targetTime,
              currentTime: video.currentTime,
              driftMs: drift,
              ts: now,
            });
            
            // Production drift correction check:
            if (drift < -200 || drift > 500) {
              video.currentTime = targetTime;
              this.profiler.stalls += 1;
            }
          }
          
          // Estimate React render overhead: each frame triggers Sequence, Item, VideoContent, Playhead, Timecode
          this.profiler.reactRenderEstimates += scenario.layerCount ? (scenario.layerCount * 3 + 2) : 5;
        });
        
        // 6. Connect rVFC if supported
        if (typeof video.requestVideoFrameCallback === 'function') {
          const onFrame = (now, meta) => {
            if (this.profiler.recording) {
              this.profiler.rvfcSamples.push({
                now,
                mediaTime: meta.mediaTime,
                presentedFrames: meta.presentedFrames,
              });
            }
            if (!video.paused) {
              video.requestVideoFrameCallback(onFrame);
            }
          };
          video.addEventListener('play', () => {
            video.requestVideoFrameCallback(onFrame);
          });
        }
        
        // 7. RAF loop tracker
        const onRaf = (ts) => {
          if (this.profiler.recording) {
            this.profiler.rafTimestamps.push(ts);
          }
          requestAnimationFrame(onRaf);
        };
        requestAnimationFrame(onRaf);
        
        return new Promise((resolve) => {
          video.oncanplay = () => resolve({ ready: true, duration: video.duration });
        });
      },
      
      async start() {
        this.profiler.recording = true;
        this.profiler.startTime = performance.now();
        this.profiler.rafTimestamps = [];
        this.profiler.clockTicks = [];
        this.profiler.zustandDispatches = 0;
        this.profiler.longTasks = [];
        this.profiler.driftSamples = [];
        this.profiler.rvfcSamples = [];
        this.profiler.reactRenderEstimates = 0;
        this.profiler.stalls = 0;
        
        if (this.audioContext && this.audioContext.state === 'suspended') {
          await this.audioContext.resume();
        }
        
        this.clock.play();
        this.videoElement.playbackRate = 1;
        await this.videoElement.play();
      },
      
      async stop() {
        this.clock.pause();
        this.videoElement.pause();
        this.profiler.recording = false;
        this.profiler.endTime = performance.now();
        return this.getReport();
      },
      
      getReport() {
        const p = this.profiler;
        const elapsedMs = p.endTime - p.startTime;
        const elapsedSec = elapsedMs / 1000;
        const fps = this.scenario.fps || 30;
        const expectedFrameMs = 1000 / fps;
        
        const intervals = [];
        for (let i = 1; i < p.rafTimestamps.length; i++) {
          intervals.push(p.rafTimestamps[i] - p.rafTimestamps[i - 1]);
        }
        
        const clockIntervals = [];
        for (let i = 1; i < p.clockTicks.length; i++) {
          clockIntervals.push(p.clockTicks[i].ts - p.clockTicks[i - 1].ts);
        }
        
        const minI = intervals.length ? Math.min(...intervals) : 0;
        const maxI = intervals.length ? Math.max(...intervals) : 0;
        const meanI = intervals.length ? (intervals.reduce((a, b) => a + b, 0) / intervals.length) : 0;
        const sortedI = [...intervals].sort((a, b) => a - b);
        const medianI = sortedI.length ? sortedI[Math.floor(sortedI.length / 2)] : 0;
        const p95I = sortedI.length ? sortedI[Math.floor(sortedI.length * 0.95)] : 0;
        const variance = intervals.length ? intervals.reduce((s, v) => s + Math.pow(v - meanI, 2), 0) / intervals.length : 0;
        const stdDev = Math.sqrt(variance);
        
        const totalPresented = p.clockTicks.length;
        const expectedFrames = Math.round(elapsedSec * fps);
        const actualFps = totalPresented / elapsedSec;
        const droppedFrames = Math.max(0, expectedFrames - totalPresented);
        const droppedPct = (droppedFrames / Math.max(1, expectedFrames)) * 100;
        
        const totalBlockingTime = p.longTasks.reduce((sum, t) => sum + Math.max(0, t.duration - 50), 0);
        const maxLongTask = p.longTasks.length ? Math.max(...p.longTasks.map(t => t.duration)) : 0;
        
        const drifts = p.driftSamples.map(s => s.driftMs);
        const avgDrift = drifts.length ? (drifts.reduce((a, b) => a + b, 0) / drifts.length) : 0;
        const maxDrift = drifts.length ? Math.max(...drifts.map(Math.abs)) : 0;
        
        const container = document.getElementById('stage-container');
        const backingSize = getRealtimePreviewRenderSize({ width: 1920, height: 1080 }, { width: 960, height: 540 });
        
        const report = {
          elapsedSeconds: Number(elapsedSec.toFixed(2)),
          targetFps: fps,
          actualPreviewFps: Number(actualFps.toFixed(2)),
          expectedFrames,
          presentedFrames: totalPresented,
          droppedFrames,
          droppedFramePercentage: Number(droppedPct.toFixed(2)),
          presentationInterval: {
            minMs: Number(minI.toFixed(2)),
            maxMs: Number(maxI.toFixed(2)),
            meanMs: Number(meanI.toFixed(2)),
            medianMs: Number(medianI.toFixed(2)),
            p95Ms: Number(p95I.toFixed(2)),
            stdDevMs: Number(stdDev.toFixed(2)),
            expectedFrameBudgetMs: Number(expectedFrameMs.toFixed(2)),
            jitterSpikesCount: intervals.filter(d => d > expectedFrameMs * 1.8).length,
          },
          mainThreadLongTasks: {
            count: p.longTasks.length,
            maxDurationMs: Number(maxLongTask.toFixed(2)),
            totalBlockingTimeMs: Number(totalBlockingTime.toFixed(2)),
          },
          zustandUpdatesPerSecond: Number((p.zustandDispatches / elapsedSec).toFixed(2)),
          totalZustandUpdates: p.zustandDispatches,
          estimatedReactRendersPerSecond: Number((p.reactRenderEstimates / elapsedSec).toFixed(2)),
          avDrift: {
            sampleCount: drifts.length,
            avgDriftMs: Number(avgDrift.toFixed(2)),
            maxDriftMs: Number(maxDrift.toFixed(2)),
            finalDriftMs: drifts.length ? Number(drifts[drifts.length - 1].toFixed(2)) : 0,
            forcedResyncsDueToDrift: p.stalls,
          },
          previewResolution: {
            sourceResolution: '1920x1080',
            backingRenderSize: \`\${backingSize.width}x\${backingSize.height}\`,
            cssDisplaySize: '960x540',
            renderedFullResolutionUnnecessarily: backingSize.width === 1920 && backingSize.height === 1080,
          },
          mediaEngine: {
            supportsRequestVideoFrameCallback: typeof HTMLVideoElement.prototype.requestVideoFrameCallback === 'function',
            rvfcFramesPresented: p.rvfcSamples.length,
            audioContextState: this.audioContext?.state ?? 'none',
          }
        };
        
        document.getElementById('metrics-display').textContent = JSON.stringify(report, null, 2);
        return report;
      }
    };
  </script>
</body>
</html>`;

// Write the benchmark page into the workspace so the Vite dev server serves it
const BENCHMARK_PAGE_PATH = '/Users/adityasamant/SCLIP/freecut/playback-bench.html'
fs.writeFileSync(BENCHMARK_PAGE_PATH, BENCHMARK_HTML)
console.log(`Created benchmark stage at ${BENCHMARK_PAGE_PATH}`)

async function runBenchmarkCase(browserType, caseName, scenarioConfig, durationSec) {
  console.log(`\n======================================================`);
  console.log(`Profiling: ${browserType.name()} | ${caseName} | ${durationSec}s`);
  console.log(`======================================================`);

  const browser = await browserType.launch({
    headless: true,
    channel: browserType.name() === 'chromium' ? 'chrome' : undefined,
  });

  try {
    const context = await browser.newContext({
      viewport: { width: 1440, height: 900 },
      deviceScaleFactor: 2,
    });
    const page = await context.newPage();

    let pageErrors = [];
    page.on('pageerror', (e) => pageErrors.push(e.message));

    // Load the benchmark page served by Vite
    await page.goto('http://localhost:5173/playback-bench.html', { waitUntil: 'load' });
    await page.waitForFunction(() => Boolean(window.__BENCHMARK_ENGINE__), { timeout: 10000 });

    // Initialize scenario
    const ready = await page.evaluate(async (cfg) => {
      return await window.__BENCHMARK_ENGINE__.init(cfg);
    }, scenarioConfig);

    console.log(`Engine ready: ${ready.ready}, media duration: ${ready.duration}s`);

    // Start playback & profiler
    await page.evaluate(async () => {
      await window.__BENCHMARK_ENGINE__.start();
    });

    // Run for requested duration
    await new Promise((r) => setTimeout(r, durationSec * 1000));

    // Stop and get detailed report
    const report = await page.evaluate(async () => {
      return await window.__BENCHMARK_ENGINE__.stop();
    });

    console.log(`Result Summary:`);
    console.log(`- Actual FPS: ${report.actualPreviewFps} / Target: ${report.targetFps}`);
    console.log(`- Dropped Frames: ${report.droppedFrames} (${report.droppedFramePercentage}%)`);
    console.log(`- Frame Interval: mean ${report.presentationInterval.meanMs}ms, p95 ${report.presentationInterval.p95Ms}ms, jitter spikes: ${report.presentationInterval.jitterSpikesCount}`);
    console.log(`- Long Tasks: ${report.mainThreadLongTasks.count} (max ${report.mainThreadLongTasks.maxDurationMs}ms, TBT ${report.mainThreadLongTasks.totalBlockingTimeMs}ms)`);
    console.log(`- Zustand Updates/sec: ${report.zustandUpdatesPerSecond}`);
    console.log(`- Estimated React Renders/sec: ${report.estimatedReactRendersPerSecond}`);
    console.log(`- A/V Drift: max ${report.avDrift.maxDriftMs}ms, avg ${report.avDrift.avgDriftMs}ms, resyncs: ${report.avDrift.forcedResyncsDueToDrift}`);

    return {
      engine: browserType.name(),
      caseName,
      durationSec,
      report,
      errors: pageErrors,
    };
  } finally {
    await browser.close();
  }
}

async function runAll() {
  const allResults = [];
  const durations = [5, 30, 60];

  const cases = [
    {
      name: 'Case A (1080p30 H.264 + Audio)',
      config: {
        fps: 30,
        durationInFrames: 1800,
        mediaUrl: '/test-media/standard_1080p30_60s.mp4',
        hasAudio: true,
        hasEffects: false,
        layerCount: 1,
      },
    },
    {
      name: 'Case B (1080p30 Video Clean, No Audio/Effects)',
      config: {
        fps: 30,
        durationInFrames: 1800,
        mediaUrl: '/test-media/standard_1080p30_60s.mp4',
        hasAudio: false,
        hasEffects: false,
        layerCount: 1,
      },
    },
    {
      name: 'Case C (1080p30 With Transform & GPU Effects)',
      config: {
        fps: 30,
        durationInFrames: 1800,
        mediaUrl: '/test-media/standard_1080p30_60s.mp4',
        hasAudio: true,
        hasEffects: true,
        transform: { scale: 0.85, rotation: 5, opacity: 0.95 },
        layerCount: 1,
      },
    },
    {
      name: 'Case D (Multiple Timeline Layers)',
      config: {
        fps: 30,
        durationInFrames: 1800,
        mediaUrl: '/test-media/standard_1080p30_60s.mp4',
        hasAudio: true,
        hasEffects: false,
        layerCount: 3,
      },
    },
  ];

  // We test in WebKit (macOS desktop WKWebView engine) and Chrome
  const engines = [webkit, chromium];

  for (const engine of engines) {
    for (const c of cases) {
      for (const dur of durations) {
        try {
          const res = await runBenchmarkCase(engine, c.name, c.config, dur);
          allResults.push(res);
        } catch (err) {
          console.error(`Failed ${engine.name()} ${c.name} ${dur}s:`, err);
        }
      }
    }
  }

  const outJson = path.join(SCRATCH_DIR, 'playback-benchmark-raw-data.json');
  fs.writeFileSync(outJson, JSON.stringify(allResults, null, 2));
  console.log(`\n======================================================`);
  console.log(`All benchmark measurements saved to: ${outJson}`);
  console.log(`======================================================`);
}

runAll().catch(console.error);
