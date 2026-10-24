// Run: node tests/tools/pi-session-runtime-smoke.mjs /path/to/pi-coding-agent
import assert from 'node:assert/strict'
import { resolve } from 'node:path'
import { runProcess } from '@orca/process-host'

assert.ok(process.argv[2], 'Pass an installed Pi 1.3.0 package directory')
const result = await runProcess({
  program: process.execPath,
  args: [
    resolve('node_modules/vitest/vitest.mjs'),
    'run',
    '--config',
    'config/vitest.config.ts',
    'src/main/pi/agent-status-real-pi-runtime.test.ts',
    '--maxWorkers',
    '1',
    '--project',
    'node'
  ],
  env: {
    ...process.env,
    ORCA_BACKGROUND_LAUNCH: '1',
    ORCA_PI_TEST_PACKAGE: resolve(process.argv[2])
  },
  timeoutMs: 60000
})
process.stdout.write(result.stdout)
process.stderr.write(result.stderr)
assert.equal(result.code, 0, 'Pinned Pi session contract failed')
