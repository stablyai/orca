import { spawnSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, readdirSync, writeFileSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
if (process.env.ORCA_BACKGROUND_LAUNCH !== '1') {
  throw new Error('Requires ORCA_BACKGROUND_LAUNCH=1')
}
const root = fileURLToPath(new URL('../../../', import.meta.url))
const parent = path.join(root, '.bench-fixtures')
mkdirSync(parent, { recursive: true })
const output = mkdtempSync(path.join(parent, 'cross-machine-recovery-rendered-'))
const specs = [
  'tests/e2e/cross-machine-recovery-rendered.spec.ts',
  'tests/e2e/cross-machine-recovery-two-profile.spec.ts',
  'tests/e2e/recovered-session-placeholder-narrow-pane.spec.ts'
]
const run = spawnSync(
  'npx',
  [
    'playwright',
    'test',
    ...specs,
    '--config',
    'tests/playwright.config.ts',
    '--project',
    'electron-headless',
    '--workers=1',
    '--reporter=line'
  ],
  {
    cwd: root,
    stdio: 'inherit',
    env: { ...process.env, ORCA_BACKGROUND_LAUNCH: '1', ORCA_RECOVERY_RENDERED_DIR: output }
  }
)
const expected = [
  'picker-complete.png',
  'picker-partial.png',
  'picker-paused.png',
  'picker-collision.png',
  'picker-divergence.png',
  'two-profile-1-before-import.png',
  'two-profile-2-imported-layout.png',
  'two-profile-3-structured-placeholder.png',
  'two-profile-4-after-resume-and-shell.png',
  'placeholder-50px-compact.png',
  'placeholder-50px-menu.png'
]
const captured = readdirSync(output).filter((file) => file.endsWith('.png'))
const missing = expected.filter((file) => !captured.includes(file))
const report = {
  scope:
    'Recover Sessions picker per provider state against a fake cc-sync provider, the two-profile import placeholders, and the placeholder in a 50px pane, in hidden Electron windows.',
  playwrightExitStatus: run.status,
  captured: captured.sort(),
  missing
}
writeFileSync(path.join(output, 'report.json'), `${JSON.stringify(report, null, 2)}\n`)
console.log(`Cross-machine recovery rendered evidence: ${output}`)
if (run.status !== 0 || missing.length > 0) {
  process.exit(run.status || 1)
}
