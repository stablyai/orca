import { mkdtempSync, writeFileSync, readFileSync, rmSync, mkdirSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import assert from 'node:assert/strict'
import { runProcess } from '../../src/shared/child-process/run-process'
import { withFreshOmpLaunch } from '../../src/shared/omp-fresh-launch'
if (process.platform !== 'win32') {
  throw new Error('Run this smoke on a Windows host')
}
const root = mkdtempSync(join(tmpdir(), 'orca-fresh-windows-'))
const config = join(root, 'fresh settings.yml')
const capture = join(root, 'calls')
const results = []
try {
  writeFileSync(join(root, 'omp.cmd'), '@echo off\r\necho %*>>"%CAPTURE%"\r\nexit /b 17\r\n')
  for (const shell of ['cmd', 'powershell'] as const) {
    for (const state of ['present', 'missing', 'unset', 'directory']) {
      rmSync(config, { force: true, recursive: true })
      rmSync(capture, { force: true })
      if (state === 'present') {
        writeFileSync(config, 'autoResume: false\n')
      }
      if (state === 'directory') {
        mkdirSync(config)
      }
      const env: NodeJS.ProcessEnv = {
        ...process.env,
        ORCA_BACKGROUND_LAUNCH: '1',
        ORCA_OMP_FRESH_CONFIG: config,
        CAPTURE: capture
      }
      if (state === 'unset') {
        delete env.ORCA_OMP_FRESH_CONFIG
      }
      const command = withFreshOmpLaunch('omp', shell, ' "task with spaces"')
      const runner = join(root, 'run.cmd')
      writeFileSync(runner, `@echo off\r\n${command}\r\n`)
      const result = await runProcess({
        program: shell === 'cmd' ? runner : 'powershell.exe',
        args:
          shell === 'cmd'
            ? []
            : [
                '-NoProfile',
                '-NonInteractive',
                '-Command',
                `function omp { $args | ConvertTo-Json -Compress | Add-Content -LiteralPath $env:CAPTURE; $global:LASTEXITCODE = 17 }; ${
                  command
                }; exit $global:LASTEXITCODE`
              ],
        cwd: root,
        env
      })
      assert.equal(
        result.code,
        state === 'present' ? 17 : 1,
        JSON.stringify({ shell, state, ...result })
      )
      if (state === 'present') {
        const calls = readFileSync(capture, 'utf8').trim().split(/\r?\n/)
        assert.equal(calls.length, 1)
        assert.ok(calls[0].includes('--config'))
        assert.ok(calls[0].includes('task with spaces'))
      } else {
        assert.ok(
          result.stderr.includes('fresh OMP settings are unavailable'),
          JSON.stringify(result)
        )
        assert.throws(() => readFileSync(capture))
      }
      results.push({ shell, state, code: result.code, passed: true })
    }
  }
  console.log(JSON.stringify(results))
} finally {
  rmSync(root, { recursive: true, force: true })
}
