import { mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { runProcess } from './child-process/run-process'
import { windowsPowerShellPath, windowsSystem32Binary } from './child-process/windows-system-binary'
import { removeTreeSync } from './windows-transient-lock-removal'
import { resolveAgentResumeCommand } from './agent-resume-command'
import { quoteStartupArg } from './tui-agent-startup-shell'

describe.skipIf(process.platform !== 'win32')('resume quoting in real Windows shells', () => {
  let directory: string
  let recorder: string

  beforeAll(() => {
    directory = mkdtempSync(join(tmpdir(), 'orca-resume-quoting-'))
    recorder = join(directory, 'argv.cjs')
    writeFileSync(recorder, 'console.log("ORCA_ARGV:" + JSON.stringify(process.argv.slice(2)))')
  })

  afterAll(() => removeTreeSync(directory))

  async function runLines(shell: 'cmd' | 'powershell', suffixes: string[]): Promise<string[][]> {
    const prefix =
      shell === 'cmd'
        ? '"%ORCA_ARGV_NODE%" "%ORCA_ARGV_RECORDER%"'
        : '& $env:ORCA_ARGV_NODE $env:ORCA_ARGV_RECORDER'
    const lines = suffixes.map((suffix) => `${prefix} ${suffix}`).join('\r\n')
    const result = await runProcess({
      program: shell === 'cmd' ? windowsSystem32Binary('cmd.exe') : windowsPowerShellPath(),
      args:
        shell === 'cmd'
          ? ['/d', '/q', '/k', 'chcp 65001 > nul']
          : ['-NoLogo', '-NoProfile', '-NonInteractive', '-Command', lines],
      ...(shell === 'cmd' ? { input: `${lines}\r\nexit\r\n` } : {}),
      env: { ...process.env, ORCA_ARGV_NODE: process.execPath, ORCA_ARGV_RECORDER: recorder }
    })
    expect(result.code, result.stderr).toBe(0)
    expect(result.timedOut).toBe(false)
    return [...result.stdout.matchAll(/ORCA_ARGV:(\[[^\r\n]*\])/g)].map((match) =>
      JSON.parse(match[1])
    )
  }

  it.each(['cmd', 'powershell'] as const)(
    'round-trips accepted arguments through %s',
    async (shell) => {
      const values = [
        'resume',
        '--resume',
        'session-1',
        'C:\\work\\repo',
        'two words',
        "it's literal",
        'a;b',
        '#tag',
        '{text}'
      ]
      expect(
        await runLines(shell, [values.map((value) => quoteStartupArg(value, 'cmd')).join(' ')])
      ).toEqual([values])
    }
  )

  it.each(['cmd', 'powershell'] as const)(
    'executes structured resume arguments in %s',
    async (shell) => {
      const values = [
        'C:\\work (x86)\\repo',
        'C:\\a^b\\',
        'a&b',
        ...(shell === 'powershell' ? ['a\u201cb\u201dc'] : [])
      ]
      const suffixes = values.map((value) => {
        const command = resolveAgentResumeCommand(
          {
            agent: 'codex',
            providerSession: { key: 'session_id', id: 'session-1' },
            cmdOverrides: {},
            sourceShell: 'powershell',
            agentArgs: `--add-dir '${value}'`
          },
          `${shell}.exe`
        )!
        return command.replace(/^(?:codex|"codex"|& 'codex') /, '')
      })
      expect(await runLines(shell, suffixes)).toEqual(
        values.map((value) => ['--add-dir', value, 'resume', 'session-1'])
      )
    }
  )

  it('preserves cmd metacharacters as literal arguments', async () => {
    const values = ['fix "quoted" & %PATH%', 'C:\\a^b\\', 'a!b', 'x|y', '(x)', 'a>b']
    expect(
      await runLines('cmd', [values.map((value) => quoteStartupArg(value, 'cmd')).join(' ')])
    ).toEqual([values])
  })

  it('reproduces literal single quotes in cmd and verifies the double-quote fix', async () => {
    expect(await runLines('cmd', ["'resume' 'session-1'", '"resume" "session-1"'])).toEqual([
      ["'resume'", "'session-1'"],
      ['resume', 'session-1']
    ])
  })

  it('uses PowerShell quoting for smart quotes in a PowerShell pane', async () => {
    const value = 'a\u201cb\u201dc'
    const results = await runLines('powershell', [
      quoteStartupArg(value, 'powershell'),
      quoteStartupArg(value, 'cmd')
    ])
    expect(results[0]).toEqual([value])
    expect(results[1]).not.toEqual([value])
  })
})
