import { webkit, chromium } from 'playwright'
import fs from 'node:fs'
import path from 'node:path'

const BENCH_URL = 'http://127.0.0.1:5173/project1-bench.html'
const RESULTS_FILE = '/Users/adityasamant/.gemini/antigravity/brain/89f99ce6-d8b2-4526-8a8d-0a3ad66ef880/scratch/project1-profiling-raw.json'

const SCENARIOS = [
  {
    scenarioName: '1. Project 1 Section A (3K 2940x1912 + GPU Brightness)',
    startFrame: 0,
    durationFrames: 150,
    disableEffects: false,
    use1080pMedia: false,
  },
  {
    scenarioName: '2. Project 1 Section A without GPU Effect (3K only)',
    startFrame: 0,
    durationFrames: 150,
    disableEffects: true,
    use1080pMedia: false,
  },
  {
    scenarioName: '3. Project 1 Section A with 1080p + GPU Brightness',
    startFrame: 0,
    durationFrames: 150,
    disableEffects: false,
    use1080pMedia: true,
  },
  {
    scenarioName: '4. Simple 1080p H.264 Baseline (No Effects)',
    startFrame: 0,
    durationFrames: 150,
    disableEffects: true,
    use1080pMedia: true,
  },
  {
    scenarioName: '5. Project 1 Section D (10-bit HEVC 1080x1920 9.7Mbps)',
    startFrame: 2130,
    durationFrames: 300,
    disableEffects: false,
    use1080pMedia: false,
  },
  {
    scenarioName: '6. Project 1 Section E (Multi-Cut 16fps Video)',
    startFrame: 4230,
    durationFrames: 300,
    disableEffects: false,
    use1080pMedia: false,
  },
]

async function runBrowserProfile(browserType, browserName) {
  console.log(`\n======================================================`)
  console.log(`Starting Profile on Engine: ${browserName.toUpperCase()}`)
  console.log(`======================================================\n`)

  const browser = await browserType.launch({
    headless: true,
    args: ['--enable-features=SharedArrayBuffer'],
  })
  const context = await browser.newContext({
    viewport: { width: 1440, height: 900 },
    deviceScaleFactor: 2,
  })
  const page = await context.newPage()

  page.on('console', (msg) => {
    if (msg.type() === 'error' || msg.text().includes('warn')) {
      console.log(`[${browserName} Console ${msg.type()}]`, msg.text())
    }
  })

  console.log(`Navigating to ${BENCH_URL}...`)
  await page.goto(BENCH_URL, { waitUntil: 'networkidle' })

  // Wait until benchmark engine is ready
  await page.waitForFunction(() => {
    return (
      window.__PROJECT1_BENCH__ &&
      window.__PROJECT1_BENCH__.getStatus().includes('Ready')
    )
  }, { timeout: 15000 })

  console.log(`Harness ready. Executing scenarios...`)
  const results = []

  for (const sc of SCENARIOS) {
    console.log(`\n>>> Running: ${sc.scenarioName} ...`)
    const res = await page.evaluate(async (config) => {
      return await window.__PROJECT1_BENCH__.runBenchmark(config)
    }, sc)

    console.log(`    Target FPS:       ${res.targetFps}`)
    console.log(`    Actual FPS:       ${res.actualPreviewFps}`)
    console.log(`    Dropped Frames:   ${res.droppedFrames} / ${res.totalFramesExpected} (${res.dropPercentage}%)`)
    console.log(`    Mean Interval:    ${res.meanFrameIntervalMs} ms`)
    console.log(`    P95 Interval:     ${res.p95FrameIntervalMs} ms`)
    console.log(`    Max Interval:     ${res.maxFrameIntervalMs} ms`)
    console.log(`    Jitter >50ms:     ${res.frameJitterSpikesOver50ms}`)
    console.log(`    Jitter >100ms:    ${res.frameJitterSpikesOver100ms}`)
    console.log(`    Long Tasks:       ${res.longTasksCount} (TBT: ${res.totalBlockingTimeMs} ms, Max: ${res.maxLongTaskMs} ms)`)
    console.log(`    Max A/V Drift:    ${res.avDriftMaxMs} ms (Avg: ${res.avDriftAvgMs} ms)`)
    console.log(`    React Renders:    ${res.reactRendersCount}`)
    console.log(`    Hard Seeks:       ${res.hardSeeksCount}`)
    console.log(`    rVFC Callbacks:   ${res.rvfcCallbacksCount}`)

    results.push({
      engine: browserName,
      ...res,
    })

    // Cooldown between runs
    await new Promise((r) => setTimeout(r, 1000))
  }

  await browser.close()
  return results
}

async function main() {
  const allResults = []

  // 1. WebKit (macOS SCLIP Engine)
  try {
    const webkitResults = await runBrowserProfile(webkit, 'WebKit')
    allResults.push(...webkitResults)
  } catch (err) {
    console.error('WebKit profiling failed:', err)
  }

  // 2. Chromium (for cross-engine baseline comparison)
  try {
    const chromiumResults = await runBrowserProfile(chromium, 'Chromium')
    allResults.push(...chromiumResults)
  } catch (err) {
    console.error('Chromium profiling failed:', err)
  }

  fs.mkdirSync(path.dirname(RESULTS_FILE), { recursive: true })
  fs.writeFileSync(RESULTS_FILE, JSON.stringify(allResults, null, 2))
  console.log(`\nRaw results saved to ${RESULTS_FILE}`)
}

main().catch(console.error)
