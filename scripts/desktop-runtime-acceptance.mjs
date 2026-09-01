import fs from 'node:fs'
import path from 'node:path'

const args = process.argv.slice(2)
const appIndex = args.indexOf('--app')
const appPath = appIndex >= 0 ? args[appIndex + 1] : '/Applications/SCLIP.app'
const realModel = args.includes('--real-model')
const executable = path.join(appPath, 'Contents', 'MacOS', 'SCLIP')

if (!fs.existsSync(executable)) {
  console.error(`DESKTOP_RUNTIME_UNAVAILABLE: expected built application at ${executable}`)
  process.exitCode = 1
} else if (realModel && process.env.SCLIP_REAL_MODEL_ACCEPTANCE !== '1') {
  // This guard prevents an accidental paid/provider invocation from normal CI.
  console.log('REAL_MODEL_TEST_SKIPPED: set SCLIP_REAL_MODEL_ACCEPTANCE=1 after configuring a real provider and a disposable project.')
} else {
  console.log(`DESKTOP_RUNTIME_MANUAL_ACCEPTANCE_REQUIRED: ${appPath}`)
  console.log('Follow docs/real-architecture-acceptance.md, recording the gateway diagnostic before and after each close/reopen cycle.')
  if (realModel) {
    console.log('REAL_MODEL_MANUAL_RUN_REQUIRED: execute the documented chat → Hermes → MCP → editor-state scenario and attach the exported diagnostic ledger.')
  }
}
