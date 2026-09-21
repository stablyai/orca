import { mkdtemp, writeFile, readFile, rm, mkdir } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { expect, it } from 'vitest'
import { runProcess } from './child-process/run-process'
import { buildAgentDraftLaunchPlan } from './tui-agent-startup'

it.skipIf(process.platform !== 'win32').each(['cmd', 'powershell'] as const)(
  'clears the draft and preserves status in native %s',
  async (shell) => {
    const root = await mkdtemp(join(tmpdir(), 'orca-omp-draft-'))
    try {
      const config = join(root, 'fresh (%ORCA_EXPANSION_PROBE%) & settings!.yml')
      const calls = join(root, 'calls')
      await writeFile(
        join(root, 'omp.cmd'),
        '@echo off\r\necho %ORCA_OMP_PREFILL%>>"%CAPTURE%"\r\nexit /b 17\r\n'
      )
      const plan = buildAgentDraftLaunchPlan({
        agent: 'omp',
        draft: 'task with spaces',
        cmdOverrides: {},
        platform: 'win32',
        shell
      })
      if (!plan) {
        throw new Error('Expected draft plan')
      }
      for (const state of ['present', 'missing', 'unset', 'directory']) {
        await rm(config, { force: true, recursive: true })
        await rm(calls, { force: true })
        if (state === 'present') {
          await writeFile(config, 'autoResume: false\n')
        }
        if (state === 'directory') {
          await mkdir(config)
        }
        const env = {
          ...process.env,
          ...plan.env,
          ORCA_OMP_FRESH_CONFIG: state === 'unset' ? undefined : config,
          CAPTURE: calls,
          ORCA_EXPANSION_PROBE: 'unexpected'
        }
        const result =
          shell === 'cmd'
            ? await runProcess({
                program: 'cmd.exe',
                args: ['/d', '/q'],
                cwd: root,
                env,
                input: `${plan.launchCommand}\r\nset "orca_result=%errorlevel%"\r\nif defined ORCA_OMP_PREFILL exit 91\r\nexit %orca_result%\r\n`
              })
            : await runProcess({
                program: 'powershell.exe',
                args: [
                  '-NoProfile',
                  '-NonInteractive',
                  '-Command',
                  `function omp { Add-Content -LiteralPath $env:CAPTURE -Value $env:ORCA_OMP_PREFILL; $global:LASTEXITCODE = 17 }; ${plan.launchCommand}; $result = $LASTEXITCODE; if (Test-Path Env:ORCA_OMP_PREFILL) { exit 91 }; exit $result`
                ],
                cwd: root,
                env
              })
        expect(result.code, JSON.stringify({ state, ...result })).toBe(state === 'present' ? 17 : 1)
        if (state === 'present') {
          expect((await readFile(calls, 'utf8')).trim()).toBe('task with spaces')
        } else {
          await expect(readFile(calls)).rejects.toMatchObject({ code: 'ENOENT' })
        }
      }
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  }
)
