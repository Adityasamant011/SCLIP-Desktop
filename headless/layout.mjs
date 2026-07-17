// FreeCut headless layout-dump CLI.
//
// Prints the COMPUTED on-canvas bounding box of every visible item at a given
// frame, as JSON — WITHOUT rendering. It reuses the exact transform resolver
// the export path uses, so the coordinates match what a render would draw. Use
// it to verify text/shape/clip positioning (x, y, w, h, opacity, z-order)
// without a slow render round-trip.
//
// Coordinates are canvas-space top-left corners (origin at the canvas top-left,
// +x right, +y down). `z` is draw order (higher = composited on top).
//
// Usage:
//   node headless/layout.mjs --workspace <dir> --project <id|project.json> --at <sec>
//   node headless/layout.mjs --workspace <dir> --project <id> --frame <n> --out layout.json
//
// Options:
//   --at <sec>           Time to inspect (seconds). Default 0.
//   --frame <n>          Frame index to inspect (overrides --at).
//   --out <path>         Write JSON to a file (default: print to stdout).
//   --head               Run headed (visible browser) for debugging.
//   --build              Build dist/ first if the harness isn't built.
//   --harness-url <url>  Dev mode: drive a running Vite dev server instead of dist/.
//
// Status/logs go to stderr; only the layout JSON goes to stdout, so it pipes
// cleanly (e.g. `... | jq '.items[] | select(.type=="text")'`).
import { chromium } from 'playwright'
import fs from 'node:fs'
import path from 'node:path'
import { parseArgs, chromeLaunchArgs } from './lib/cli.mjs'
import { startHarness, loadJobProject, resolveProjectMedia } from './lib/render-core.mjs'

async function main() {
  const args = parseArgs(process.argv.slice(2))
  const workspace = args.workspace
  if (!workspace) throw new Error('Missing --workspace <dir>')
  if (!fs.existsSync(workspace)) throw new Error(`Workspace not found: ${workspace}`)
  if (!args.project) throw new Error('Missing --project <id|project.json>')

  const atSeconds = args.at !== undefined ? Number(args.at) : undefined
  const frame = args.frame !== undefined ? Number(args.frame) : undefined

  const { harnessUrl, mediaUrlOf, closeServers } = await startHarness({
    workspace,
    devUrl: args['harness-url'],
    build: args.build,
  })
  console.error(`Harness: ${harnessUrl}`)

  const browser = await chromium.launch({
    channel: 'chrome',
    headless: !args.head,
    args: chromeLaunchArgs(),
  })
  try {
    const context = await browser.newContext()
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
    // Only metadata is used (source dimensions); URLs are never fetched here.
    const { media, missing } = resolveProjectMedia(workspace, project, mediaUrlOf, null)
    if (missing.length > 0) {
      console.error(
        `  NOTE: ${missing.length} media source(s) not on disk; their default size may be off: ${missing.join(', ')}`,
      )
    }

    const layout = await page.evaluate((payload) => window.freecut.dumpLayout(payload), {
      project,
      media,
      frame,
      atSeconds,
    })

    const json = JSON.stringify(layout, null, 2)
    if (args.out) {
      const outPath = path.resolve(args.out)
      fs.mkdirSync(path.dirname(outPath), { recursive: true })
      fs.writeFileSync(outPath, json)
      console.error(
        `  Layout at frame ${layout.frame} (${layout.atSeconds.toFixed(3)}s): ${layout.items.length} item(s) -> ${outPath}`,
      )
    } else {
      console.error(
        `  Layout at frame ${layout.frame} (${layout.atSeconds.toFixed(3)}s): ${layout.items.length} item(s)`,
      )
      console.log(json)
    }
  } finally {
    await browser.close()
    await closeServers()
  }
}

main().catch((e) => {
  console.error('\nLayout dump failed:', e.message ?? e)
  process.exit(1)
})
