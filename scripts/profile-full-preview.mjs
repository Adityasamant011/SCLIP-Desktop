import { webkit, chromium } from 'playwright'
import fs from 'fs'

const SCENARIOS = [
  {
    name: '1. Project 1 Section A (3K 2940x1912 + GPU Brightness)',
    config: {
      scenarioName: '3K 2940x1912 + GPU Brightness',
      startFrame: 0,
      durationFrames: 150,
    },
    meta: {
      codec: 'H.264 High',
      res: '2940x1912',
      sourceFps: 30,
      layers: 1,
      effects: 'gpu-brightness (amount: 0.25)',
      transform: 'scaleX: 0.95, width: 1661, height: 1080',
    }
  },
  {
    name: '2. Project 1 Section A without GPU Effect (3K only)',
    config: {
      scenarioName: '3K without GPU Effect',
      startFrame: 0,
      durationFrames: 150,
      disableEffects: true,
    },
    meta: {
      codec: 'H.264 High',
      res: '2940x1912',
      sourceFps: 30,
      layers: 1,
      effects: 'none',
      transform: 'scaleX: 0.95, width: 1661, height: 1080',
    }
  },
  {
    name: '3. Project 1 Section A with 1080p + GPU Brightness',
    config: {
      scenarioName: '1080p + GPU Brightness',
      startFrame: 0,
      durationFrames: 150,
      use1080pMedia: true,
    },
    meta: {
      codec: 'H.264 High',
      res: '1920x1080',
      sourceFps: 30,
      layers: 1,
      effects: 'gpu-brightness (amount: 0.25)',
      transform: 'scaleX: 0.95, width: 1661, height: 1080',
    }
  },
  {
    name: '4. Simple 1080p H.264 Baseline (No Effects)',
    config: {
      scenarioName: '1080p Baseline No Effects',
      startFrame: 0,
      durationFrames: 150,
      use1080pMedia: true,
      disableEffects: true,
    },
    meta: {
      codec: 'H.264 Baseline',
      res: '1920x1080',
      sourceFps: 30,
      layers: 1,
      effects: 'none',
      transform: 'none',
    }
  },
  {
    name: '5. Project 1 Section D (10-bit HEVC 1080x1920 9.7Mbps)',
    config: {
      scenarioName: '10-bit HEVC 1080x1920 9.7Mbps',
      startFrame: 2130,
      durationFrames: 300,
    },
    meta: {
      codec: 'HEVC Main 10 (10-bit YUV420p10le)',
      res: '1080x1920',
      sourceFps: 30,
      layers: 1,
      effects: 'none',
      transform: 'none',
    }
  },
  {
    name: '6. Project 1 Section E (Multi-Cut 16fps Video)',
    config: {
      scenarioName: 'Multi-Cut 16fps Video',
      startFrame: 4230,
      durationFrames: 300,
    },
    meta: {
      codec: 'H.264 Constrained Baseline',
      res: '1920x1080',
      sourceFps: 16,
      layers: 1,
      effects: 'none',
      transform: 'none',
    }
  }
]

async function runProfileOnBrowser(browserType, browserName) {
  console.log(`\n======================================================`)
  console.log(`Starting Full VideoPreview Profile on Engine: ${browserName}`)
  console.log(`======================================================\n`)

  const browser = await browserType.launch({
    headless: true,
    args: browserName === 'CHROMIUM' ? ['--enable-gpu', '--use-gl=angle'] : []
  })

  const context = await browser.newContext({ viewport: { width: 1280, height: 900 } })
  const page = await context.newPage()

  page.on('console', (msg) => {
    const text = msg.text()
    if (text.includes('[CustomDecoderBufferedAudio]') || text.includes('Vite') || text.includes('react-i18next')) return
    if (msg.type() === 'error' || msg.type() === 'warning') {
      console.log(`[${browserName} Console ${msg.type()}]`, text)
    }
  })

  console.log('Navigating to http://127.0.0.1:5173/full-preview-bench.html...')
  await page.goto('http://127.0.0.1:5173/full-preview-bench.html')

  await page.waitForFunction(() => {
    return window.__FULL_PREVIEW_BENCH__ && window.__FULL_PREVIEW_BENCH__.getStatus().includes('Ready')
  }, { timeout: 30000 })

  console.log('Full VideoPreview Stage ready. Executing scenarios...\n')

  const results = []

  for (const scenario of SCENARIOS) {
    console.log(`>>> Running: ${scenario.name} ...`)
    const benchMetrics = await page.evaluate(async (cfg) => {
      return await window.__FULL_PREVIEW_BENCH__.runBenchmark(cfg)
    }, scenario.config)

    benchMetrics.engine = browserName
    benchMetrics.metadata = scenario.meta

    console.log(`    Target FPS:       ${benchMetrics.targetFps}`)
    console.log(`    Actual FPS:       ${benchMetrics.actualPreviewFps}`)
    console.log(`    Dropped Frames:   ${benchMetrics.droppedFrames} / ${benchMetrics.totalFramesExpected} (${benchMetrics.dropPercentage}%)`)
    console.log(`    Mean Interval:    ${benchMetrics.meanFrameIntervalMs} ms`)
    console.log(`    P95 Interval:     ${benchMetrics.p95FrameIntervalMs} ms`)
    console.log(`    Max Interval:     ${benchMetrics.maxFrameIntervalMs} ms`)
    console.log(`    Jitter >50ms:     ${benchMetrics.frameJitterSpikesOver50ms}`)
    console.log(`    Jitter >100ms:    ${benchMetrics.frameJitterSpikesOver100ms}`)
    console.log(`    Long Tasks:       ${benchMetrics.longTasksCount} (TBT: ${benchMetrics.totalBlockingTimeMs} ms, Max: ${benchMetrics.maxLongTaskMs} ms)`)
    console.log(`    Max A/V Drift:    ${benchMetrics.avDriftMaxMs} ms (Avg: ${benchMetrics.avDriftAvgMs} ms)`)
    console.log(`    React Renders:    ${benchMetrics.reactRendersPerSec} / sec`)
    console.log(`    Zustand Updates:  ${benchMetrics.zustandDispatchesPerSec} / sec`)
    console.log(`    Hard Seeks:       ${benchMetrics.hardSeeksCount}`)
    console.log(`    rVFC Callbacks:   ${benchMetrics.rvfcCallbacksCount}`)
    console.log(`    Render Sources:   ${benchMetrics.activeRenderSources.join(', ')}`)
    console.log('')

    results.push(benchMetrics)
    await new Promise((r) => setTimeout(r, 1000))
  }

  await browser.close()
  return results
}

async function main() {
  const webkitResults = await runProfileOnBrowser(webkit, 'WEBKIT')
  const chromiumResults = await runProfileOnBrowser(chromium, 'CHROMIUM')

  const summary = {
    timestamp: new Date().toISOString(),
    webkit: webkitResults,
    chromium: chromiumResults,
  }

  const outPath = '/Users/adityasamant/.gemini/antigravity/brain/89f99ce6-d8b2-4526-8a8d-0a3ad66ef880/scratch/project1-full-preview-results.json'
  fs.writeFileSync(outPath, JSON.stringify(summary, null, 2))
  console.log(`\nFull profile saved to ${outPath}`)
}

main().catch((err) => {
  console.error('Profiling error:', err)
  process.exit(1)
})
