// FreeCut headless single-frame grab CLI.
//
// Renders ONE frame of a project straight to an image (default: full-res PNG)
// by driving the real render engine inside headless Chrome. Much faster than
// the "encode a short clip -> ffmpeg-extract a frame" loop: no muxer, no video
// encoder, no audio pipeline — just one composited frame. Use it to eyeball an
// element's position/appearance while iterating on a project.json.
//
// Usage:
//   node headless/frame.mjs --workspace <dir> --project <id|project.json> --at <sec> [options]
//   node headless/frame.mjs --workspace <dir> --project <id> --frame <n> --out frame.png
//
// Options:
//   --at <sec>            Time to grab (seconds). Default 0.
//   --frame <n>           Frame index to grab (overrides --at).
//   --out <path>          Output image (default: ./headless/output/frame.<ext>)
//   --format <f>          png|jpg|webp (default: png)
//   --width/--height <n>  Output size (default: project resolution — full quality)
//   --quality <0..1>      Encoder quality for jpg/webp (default: 1)
//   --head                Run headed (visible browser) for debugging
//   --build               Build dist/ first if the harness isn't built
//   --harness-url <url>   Dev mode: drive a running Vite dev server instead of dist/
import { chromium } from 'playwright'
import fs from 'node:fs'
import path from 'node:path'
import { parseArgs, chromeLaunchArgs } from './lib/cli.mjs'
import { startHarness, loadJobProject, resolveProjectMedia } from './lib/render-core.mjs'

const MIME_BY_FORMAT = {
  png: 'image/png',
  jpg: 'image/jpeg',
  jpeg: 'image/jpeg',
  webp: 'image/webp',
}
const EXT_BY_MIME = { 'image/png': 'png', 'image/jpeg': 'jpg', 'image/webp': 'webp' }

async function main() {
  const args = parseArgs(process.argv.slice(2))
  const workspace = args.workspace
  if (!workspace) throw new Error('Missing --workspace <dir>')
  if (!fs.existsSync(workspace)) throw new Error(`Workspace not found: ${workspace}`)
  if (!args.project) throw new Error('Missing --project <id|project.json>')

  const format = (args.format ?? 'png').toLowerCase()
  const mime = MIME_BY_FORMAT[format]
  if (!mime) throw new Error(`Unknown --format "${args.format}" (use png|jpg|webp)`)
  const ext = EXT_BY_MIME[mime]
  const outPath = path.resolve(args.out ?? path.join('headless', 'output', `frame.${ext}`))

  const atSeconds = args.at !== undefined ? Number(args.at) : undefined
  const frame = args.frame !== undefined ? Number(args.frame) : undefined

  const { harnessUrl, mediaUrlOf, closeServers } = await startHarness({
    workspace,
    devUrl: args['harness-url'],
    build: args.build,
  })
  console.log(`Harness: ${harnessUrl}`)

  const browser = await chromium.launch({
    channel: 'chrome',
    headless: !args.head,
    args: chromeLaunchArgs(),
  })
  try {
    const context = await browser.newContext({ acceptDownloads: true })
    const page = await context.newPage()
    page.on('pageerror', (e) => console.error('  [pageerror]', e.message))
    page.on('console', (m) => {
      if (m.type() === 'error' && !m.text().includes('Video load error')) {
        console.error('  [page:error]', m.text())
      }
    })
    await page.goto(harnessUrl, { waitUntil: 'load', timeout: 60_000 })
    await page.waitForFunction(() => Boolean(window.freecut?.ready), { timeout: 30_000 })

    const { project } = loadJobProject(workspace, { project: args.project })
    const { media, missing } = resolveProjectMedia(workspace, project, mediaUrlOf, null)
    if (missing.length > 0) {
      console.warn(
        `  WARNING: ${missing.length} media source(s) not found on disk: ${missing.join(', ')}`,
      )
    }

    fs.mkdirSync(path.dirname(outPath), { recursive: true })
    const started = Date.now()
    const downloadPromise = page.waitForEvent('download', { timeout: 5 * 60_000 })
    downloadPromise.catch(() => {})
    const summary = await page.evaluate((payload) => window.freecut.renderFrame(payload), {
      project,
      media,
      frame,
      atSeconds,
      width: args.width ? Number(args.width) : undefined,
      height: args.height ? Number(args.height) : undefined,
      format: mime,
      quality: args.quality ? Number(args.quality) : undefined,
    })
    const download = await downloadPromise
    await download.saveAs(outPath)
    console.log(
      `  Frame ${summary.frame} (${summary.atSeconds.toFixed(3)}s) -> ${outPath}  ` +
        `(${summary.width}x${summary.height} ${summary.format}, ` +
        `${(summary.fileSize / 1000).toFixed(1)} KB, ${Date.now() - started}ms)`,
    )
  } finally {
    await browser.close()
    await closeServers()
  }
}

main().catch((e) => {
  console.error('\nFrame grab failed:', e.message ?? e)
  process.exit(1)
})
