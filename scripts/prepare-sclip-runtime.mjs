import { existsSync } from 'node:fs'
import path from 'node:path'
import { spawnSync } from 'node:child_process'

const root = process.cwd()
const runtime = path.join(root, 'src-tauri', 'resources', 'hermes-runtime')
const python = process.platform === 'win32'
  ? path.join(runtime, 'python', 'python.exe')
  : path.join(runtime, 'python', 'bin', 'python3.11')

function run(command, args, options = {}) {
  const result = spawnSync(command, args, { stdio: 'inherit', ...options })
  if (result.status !== 0) process.exit(result.status ?? 1)
}

if (!existsSync(python)) {
  console.error(`SCLIP_HERMES_RUNTIME_MISSING: expected ${python}`)
  process.exit(1)
}

// These are part of the SCLIP desktop runtime, not optional user installs:
// DDGS provides keyless web search and fal-client lets a user enable image
// generation immediately after adding their own FAL key in SCLIP settings.
run(python, ['-m', 'pip', 'install', '--break-system-packages', '--disable-pip-version-check', 'ddgs==9.16.0', 'fal-client==1.0.1'])

// Bundle a host-specific Node runtime and agent-browser CLI into the app. The
// Tauri launcher prepends Node's bin directory to PATH, so the end user never
// needs to install Node separately. agent-browser downloads its browser engine
// on first use when the release builder has not pre-populated it.
run(process.platform === 'win32' ? 'npm.cmd' : 'npm', ['install', '--prefix', path.join(runtime, 'node'), '--no-package-lock', '--omit=dev', 'node@22.22.3', 'agent-browser@0.26.0'])
