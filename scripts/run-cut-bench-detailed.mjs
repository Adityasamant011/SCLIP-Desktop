import fs from 'node:fs'
import path from 'node:path'
import { webkit, chromium } from 'playwright'

const SCRATCH_DIR = '/Users/adityasamant/.gemini/antigravity/brain/89f99ce6-d8b2-4526-8a8d-0a3ad66ef880/scratch'

const CUT_BENCH_HTML = `<!doctype html>
<html>
<head>
  <meta charset="utf-8">
  <title>SCLIP Cut-Crossing Precision Benchmark</title>
  <style>
    body { background: #0b0b0c; color: #fff; font-family: monospace; padding: 20px; }
    #stage { width: 960px; height: 540px; position: relative; background: #000; overflow: hidden; }
    video { width: 100%; height: 100%; object-fit: contain; position: absolute; }
  </style>
</head>
<body>
  <h1>Cut-Crossing Benchmark</h1>
  <div id="stage"></div>
  <div id="results" style="white-space: pre-wrap; margin-top: 20px; background: #18181b; padding: 15px;"></div>

  <script type="module">
    import { createClock } from '/src/runtime/player/clock/Clock.ts';
    import {
      planPlayingVideoDriftCorrection,
      planVideoFrameCallbackCorrection,
      isVideoSyncTargetDiscontinuity,
      shouldUpdateVideoPlaybackRate,
    } from '/src/runtime/composition-runtime/utils/video-sync-plan.ts';
    import { applyVideoElementAudioState } from '/src/runtime/composition-runtime/components/video-audio-context.ts';
    import { getSharedPreviewAudioContext } from '/src/runtime/composition-runtime/utils/preview-audio-graph.ts';
    
    window.__CUT_BENCH__ = {
      async run() {
        const stage = document.getElementById('stage');
        stage.innerHTML = '';
        const video = document.createElement('video');
        video.src = '/test-media/standard_1080p30_60s.mp4';
        video.playsInline = true;
        video.preload = 'auto';
        stage.appendChild(video);
        
        await new Promise(r => {
          if (video.readyState >= 3) return r();
          video.oncanplaythrough = () => r();
          setTimeout(r, 1500);
        });
        
        const fps = 30;
        const clock = createClock({ fps, durationInFrames: 300, initialFrame: 0 });
        
        const ctx = getSharedPreviewAudioContext();
        if (ctx) {
          if (ctx.state === 'suspended') await ctx.resume();
          clock.setAudioContext(ctx);
        }
        applyVideoElementAudioState(video, 1, []);
        
        const events = [];
        const driftHistory = [];
        const rateHistory = [];
        let totalSeeks = 0;
        let followUpDriftSeeks = 0;
        let lastSyncTimeMs = 0;
        let isSeeking = false;
        let lastSeekIssuedAt = 0;
        let lastSeekCompletedAt = 0;
        const POST_SEEK_GRACE_MS = 300;
        
        const isPostSeekSettling = () => {
          if (isSeeking || video.seeking) return true;
          return (performance.now() - lastSeekCompletedAt) < POST_SEEK_GRACE_MS;
        };
        
        video.addEventListener('seeking', () => {
          isSeeking = true;
          events.push({ type: 'seeking', time: performance.now(), mediaTime: video.currentTime });
        });
        video.addEventListener('seeked', () => {
          isSeeking = false;
          lastSeekCompletedAt = performance.now();
          if (video.paused) {
            video.play().catch(() => {});
          }
          events.push({ type: 'seeked', time: performance.now(), mediaTime: video.currentTime });
        });
        
        let supportsRVFC = 'requestVideoFrameCallback' in HTMLVideoElement.prototype;
        let previousTargetTime = null;
        let previousCallbackTimeMs = performance.now();
        let rvfcHandle;
        
        const onVideoFrame = () => {
          const frame = clock.currentFrame;
          let target = 0;
          if (frame < 90) {
            target = frame / fps;
          } else {
            target = 30.0 + ((frame - 90) / fps);
          }
          
          const callbackTimeMs = performance.now();
          const targetDiscontinuity = isVideoSyncTargetDiscontinuity({
            previousTargetTime,
            targetTime: target,
            elapsedMs: callbackTimeMs - previousCallbackTimeMs,
            nominalRate: 1.0,
          });
          previousTargetTime = target;
          previousCallbackTimeMs = callbackTimeMs;
          
          const settling = isPostSeekSettling();
          const correctionPlan = planVideoFrameCallbackCorrection({
            currentTime: video.currentTime,
            targetTime: target,
            nominalRate: 1.0,
            readyState: video.readyState,
            targetDiscontinuity,
            seeking: video.seeking || isSeeking,
            isPostSeekSettling: settling,
          });
          
          if (correctionPlan.kind === 'seek') {
            events.push({ type: 'rvfc_seek', frame, target, currentTime: video.currentTime, ts: callbackTimeMs });
            isSeeking = true;
            lastSeekIssuedAt = callbackTimeMs;
            video.currentTime = correctionPlan.seekTo;
            totalSeeks++;
            if (frame > 90) followUpDriftSeeks++;
          }
          if (shouldUpdateVideoPlaybackRate(video.playbackRate, correctionPlan.playbackRate)) {
            video.playbackRate = correctionPlan.playbackRate;
            rateHistory.push({ time: callbackTimeMs, rate: correctionPlan.playbackRate });
          }
          
          driftHistory.push({
            time: callbackTimeMs,
            frame,
            target,
            videoTime: video.currentTime,
            driftMs: (video.currentTime - target) * 1000,
            rate: video.playbackRate,
          });
          
          rvfcHandle = video.requestVideoFrameCallback(onVideoFrame);
        };
        
        if (supportsRVFC) {
          rvfcHandle = video.requestVideoFrameCallback(onVideoFrame);
        }
        
        clock.addEventListener('framechange', () => {
          const frame = clock.currentFrame;
          let targetTime = 0;
          if (frame < 90) {
            targetTime = frame / fps;
          } else {
            targetTime = 30.0 + ((frame - 90) / fps);
          }
          
          const now = performance.now();
          const drift = video.currentTime - targetTime;
          
          // Cut at frame 90:
          if (frame === 90) {
            const seekStart = performance.now();
            events.push({ type: 'cut_triggered', frame, targetTime, videoTimeBeforeSeek: video.currentTime, ts: seekStart });
            isSeeking = true;
            lastSeekIssuedAt = seekStart;
            previousTargetTime = targetTime;
            previousCallbackTimeMs = seekStart;
            video.currentTime = targetTime;
            totalSeeks++;
          } else if (frame > 90 && !supportsRVFC) {
            // Fallback React effect drift check if rVFC is not available
            const settling = isPostSeekSettling();
            const plan = planPlayingVideoDriftCorrection({
              canSeek: !video.seeking && !isSeeking && !settling,
              currentTime: video.currentTime,
              targetTime,
              lastSyncTimeMs,
              nowMs: now,
              seeking: video.seeking || isSeeking,
              isPostSeekSettling: settling,
            });
            if (plan.seekTo !== null) {
              events.push({ type: 'drift_seek', frame, targetTime, currentTime: video.currentTime, driftMs: drift * 1000, ts: now });
              isSeeking = true;
              lastSeekIssuedAt = now;
              video.currentTime = plan.seekTo;
              lastSyncTimeMs = now;
              totalSeeks++;
              followUpDriftSeeks++;
            }
          }
          
          if (!supportsRVFC) {
            driftHistory.push({
              time: now,
              frame,
              target: targetTime,
              videoTime: video.currentTime,
              driftMs: (video.currentTime - targetTime) * 1000,
              rate: video.playbackRate,
            });
          }
        });
        
        // Start playback
        await video.play();
        clock.play();
        
        // Run for 8 seconds (240 frames, crosses cut at frame 90 = 3.0s)
        await new Promise(r => setTimeout(r, 8000));
        
        clock.pause();
        video.pause();
        if (supportsRVFC && rvfcHandle) {
          video.cancelVideoFrameCallback(rvfcHandle);
        }
        
        const cutEvent = events.find(e => e.type === 'cut_triggered');
        const firstSeekedAfterCut = events.find(e => e.type === 'seeked' && e.time >= (cutEvent?.ts || 0));
        const cutLatencyMs = (cutEvent && firstSeekedAfterCut) ? (firstSeekedAfterCut.time - cutEvent.ts) : 0;
        
        // Measure drift samples after cut
        const postCutDrift = driftHistory.filter(d => d.frame >= 90);
        const driftAt500ms = postCutDrift.find(d => d.frame >= 105)?.driftMs ?? 0;
        const driftAt1000ms = postCutDrift.find(d => d.frame >= 120)?.driftMs ?? 0;
        const driftAt2000ms = postCutDrift.find(d => d.frame >= 150)?.driftMs ?? 0;
        const driftAt3000ms = postCutDrift.find(d => d.frame >= 180)?.driftMs ?? 0;
        const driftAt4000ms = postCutDrift.find(d => d.frame >= 210)?.driftMs ?? 0;
        const finalRate = video.playbackRate;
        
        const report = {
          supportsRVFC,
          cutLatencyMs: Number(cutLatencyMs.toFixed(2)),
          totalSeeksTriggered: totalSeeks,
          followUpDriftSeeks,
          driftAt500ms: Number(driftAt500ms.toFixed(1)),
          driftAt1000ms: Number(driftAt1000ms.toFixed(1)),
          driftAt2000ms: Number(driftAt2000ms.toFixed(1)),
          driftAt3000ms: Number(driftAt3000ms.toFixed(1)),
          driftAt4000ms: Number(driftAt4000ms.toFixed(1)),
          finalRate,
          totalEvents: events.length,
          events,
        };
        
        document.getElementById('results').textContent = JSON.stringify(report, null, 2);
        return report;
      }
    };
  </script>
</body>
</html>`;

fs.writeFileSync('/Users/adityasamant/SCLIP/freecut/cut-bench.html', CUT_BENCH_HTML);

async function runBenchmark(engineName, browserType) {
  console.log(`\n========================================`);
  console.log(`Running Cut-Crossing Benchmark on: ${engineName.toUpperCase()}`);
  console.log(`========================================`);
  
  const browser = await browserType.launch({ headless: true });
  const context = await browser.newContext({
    viewport: { width: 1440, height: 900 },
    deviceScaleFactor: 2,
  });
  const page = await context.newPage();
  
  page.on('console', msg => {
    if (msg.type() === 'error') console.log(`[Browser Console Error]`, msg.text());
  });
  
  await page.goto('http://127.0.0.1:5173/cut-bench.html', { waitUntil: 'load' });
  await page.waitForTimeout(1000);
  await page.waitForFunction(() => window.__CUT_BENCH__ !== undefined);
  
  const result = await page.evaluate(async () => {
    return await window.__CUT_BENCH__.run();
  });
  
  await browser.close();
  
  console.log(`Engine: ${engineName}`);
  console.log(`Supports rVFC: ${result.supportsRVFC}`);
  console.log(`Cut Latency: ${result.cutLatencyMs} ms`);
  console.log(`Total Seeks: ${result.totalSeeksTriggered}`);
  console.log(`Follow-up Drift Hard Seeks: ${result.followUpDriftSeeks}`);
  console.log(`Drift @ +500ms: ${result.driftAt500ms} ms`);
  console.log(`Drift @ +1000ms: ${result.driftAt1000ms} ms`);
  console.log(`Drift @ +2000ms: ${result.driftAt2000ms} ms`);
  console.log(`Drift @ +3000ms: ${result.driftAt3000ms} ms`);
  console.log(`Drift @ +4000ms: ${result.driftAt4000ms} ms`);
  console.log(`Final Playback Rate: ${result.finalRate}`);
  
  return result;
}

async function main() {
  const webkitResult = await runBenchmark('WebKit', webkit);
  const chromiumResult = await runBenchmark('Chromium', chromium);
  
  const summary = {
    timestamp: new Date().toISOString(),
    webkit: webkitResult,
    chromium: chromiumResult,
  };
  
  fs.writeFileSync(path.join(SCRATCH_DIR, 'cut-crossing-results.json'), JSON.stringify(summary, null, 2));
  console.log('\nResults saved to scratch/cut-crossing-results.json');
}

main().catch(err => {
  console.error('Benchmark error:', err);
  process.exit(1);
});
