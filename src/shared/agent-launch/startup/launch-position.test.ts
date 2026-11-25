import { expect, it } from 'vitest'
import { addClaudeTeammateModeAuto, isDirectClaudeCommand } from './claude-agent-teams-tmux-compat'
import { withClaudeDirectLaunchCommand } from './claude-direct-launch-command'
import { readLaunchArguments, readLaunchPosition } from './launch-position'
import {
  renderCmdLaunchForPowerShell,
  replaceLaunchExecutable,
  launchProgramHead
} from './managed-agent-launch-program'
import { withFreshOmpLaunch } from './omp-fresh-launch'
import type { AgentStartupShell } from './tui-agent-startup-shell'

it('reads only the executable after literal shell-specific prefixes and preserves its suffix', () => {
  const cases: {
    shell: AgentStartupShell
    command: string
    program: string
    replacement: string
    result: string
    cwd: string
    env: [string, string | undefined][]
  }[] = [
    {
      shell: 'posix',
      command: "cd /w&&CODEX_HOME='/account' env -u TRACE DEBUG=1 codex\t resume 'abc;&&'",
      program: 'codex',
      replacement: "/opt/O'Brien/codex",
      result:
        "cd /w&&CODEX_HOME='/account' env -u TRACE DEBUG=1 '/opt/O'\"'\"'Brien/codex'\t resume 'abc;&&'",
      cwd: '/w',
      env: [
        ['CODEX_HOME', '/account'],
        ['TRACE', undefined],
        ['DEBUG', '1']
      ]
    },
    {
      shell: 'powershell',
      command:
        "Remove-Item Env:TRACE -ErrorAction SilentlyContinue;Set-Location -LiteralPath 'C:\\O''Brien';$env:CODEX_HOME='C:\\account';& 'C:\\old\\codex.exe' resume 'abc;&&'",
      program: 'C:\\old\\codex.exe',
      replacement: "C:\\O'Brien\\codex.exe",
      result:
        "Remove-Item Env:TRACE -ErrorAction SilentlyContinue;Set-Location -LiteralPath 'C:\\O''Brien';$env:CODEX_HOME='C:\\account';& 'C:\\O''Brien\\codex.exe' resume 'abc;&&'",
      cwd: "C:\\O'Brien",
      env: [
        ['TRACE', undefined],
        ['CODEX_HOME', 'C:\\account']
      ]
    },
    {
      shell: 'cmd',
      command:
        'set "TRACE=" & cd /d "C:\\dir with &&"&&set "CODEX_HOME=C:\\account" && codex  resume "abc;&&"',
      program: 'codex',
      replacement: "C:\\O'Brien\\codex.exe",
      result:
        'set "TRACE=" & cd /d "C:\\dir with &&"&&set "CODEX_HOME=C:\\account" && "C:\\O\'Brien\\codex.exe"  resume "abc;&&"',
      cwd: 'C:\\dir with &&',
      env: [
        ['TRACE', undefined],
        ['CODEX_HOME', 'C:\\account']
      ]
    }
  ]
  for (const { command, shell, program, replacement, result, cwd, env } of cases) {
    const launch = readLaunchPosition(command, shell)
    expect(launch?.executable).toBe(program)
    if (!launch) {
      throw new Error('Missing executable')
    }
    expect(launch.cwd).toBe(cwd)
    expect([...launch.env]).toEqual(env)
    expect(replaceLaunchExecutable(command, shell, launch, replacement)).toBe(result)
    expect(readLaunchArguments(result, shell, readLaunchPosition(result, shell) ?? launch)).toEqual(
      ['resume', 'abc;&&']
    )
  }
})

it('stops at the first executable and ignores operators in literal arguments', () => {
  for (const [command, expected] of [
    ["printf '%s\\n' ';' '/data/orca/agent-runtimes/claude/1.0/claude'", 'printf'],
    ["echo '&&' claude", 'echo'],
    ["/bin/sh -c 'claude --verbose'", '/bin/sh'],
    ['DEBUG=1 claude --verbose', 'claude'],
    ['env DEBUG=1 claude --verbose', 'claude']
  ]) {
    expect(readLaunchPosition(command, 'posix')?.executable).toBe(expected)
  }
  expect(readLaunchPosition(`${'DEBUG=1 '.repeat(1_000)}claude`, 'posix')).toBeNull()
  expect(readLaunchPosition(`${'command '.repeat(750)}claude`, 'posix')).toBeNull()
  expect(readLaunchPosition('command command claude --x', 'posix')?.end).toBe(22)
  expect(readLaunchPosition(`claude '${'x'.repeat(100_000)}'`, 'posix')?.end).toBe(6)
})

it('gives Agent Teams the whole executable span for apostrophe paths', () => {
  const posix = "'/Users/O'\"'\"'Brien/orca/claude'"
  const powershell = "& 'C:\\Users\\O''Brien\\orca\\claude.exe'"
  expect(isDirectClaudeCommand(`${posix} 'hello && goodbye'`)).toBe(true)
  expect(isDirectClaudeCommand(powershell)).toBe(true)
  expect(addClaudeTeammateModeAuto(`${posix}  --resume x`)).toBe(
    "'/Users/O'\"'\"'Brien/orca/claude' --teammate-mode auto  --resume x"
  )
  expect(addClaudeTeammateModeAuto(`${powershell} --resume x`)).toBe(
    "& 'C:\\Users\\O''Brien\\orca\\claude.exe' --teammate-mode auto --resume x"
  )
})

it('escapes Claude native argv as an array without losing JSON or prompt quotes', () => {
  const command = withClaudeDirectLaunchCommand(
    `& 'C:\\Users\\O’’Brien\\claude.exe' --settings '{"fastMode":false}' 'O’’Brien’’s "quoted" prompt'`,
    'powershell'
  )
  expect(command.startsWith("& { $orcaProgram = 'C:\\Users\\O’’Brien\\claude.exe'; ")).toBe(true)
  expect(command).toContain(
    '$orcaNativeArgs = @(__OrcaEscapeNativeArgs $orcaProgram (@($args))); & $orcaProgram @orcaNativeArgs'
  )
  expect(
    command.endsWith(` } -- --settings '{"fastMode":false}' 'O’’Brien’’s "quoted" prompt'`)
  ).toBe(true)
})

it('distinguishes a PowerShell splat from a literal @ argument', () => {
  const command = "& 'C:\\managed\\codex.exe'"
  const launch = readLaunchPosition(command, 'powershell')
  if (!launch) {
    throw new Error('Missing executable')
  }
  expect(readLaunchArguments(`${command} @launchArgs`, 'powershell', launch)).toBeNull()
  expect(readLaunchArguments(`${command} '@launchArgs'`, 'powershell', launch)).toEqual([
    '@launchArgs'
  ])
})

it.each([
  ['C:\\Users\\x%OS%y\\claude.exe', '"C:\\Users\\x"^%"OS"^%"y\\claude.exe"'],
  ['C:\\Users\\%OS%y\\claude.exe', '"C:\\Users\\\\"^%"OS"^%"y\\claude.exe"']
])('keeps cmd percent signs literal in %s and reads back the executable', (path, head) => {
  expect(launchProgramHead(path, 'cmd')).toBe(head)
  expect(readLaunchPosition(`${head} --resume abc`, 'cmd')?.executable).toBe(path)
  expect(readLaunchPosition(`"${path}" --resume abc`, 'cmd')).toBeNull()
})

it('quotes a cmd setup launch for PowerShell and stops on a failed directory change', () => {
  const command = 'cd /d "C:\\work tree"&&set "PATH=C:\\tools" & claude --resume "a$HOME & b"'
  const launch = readLaunchPosition(command, 'cmd')
  if (!launch) {
    throw new Error('Missing executable')
  }
  expect(renderCmdLaunchForPowerShell(command, launch, "C:\\O'Brien\\claude.exe")).toBe(
    "$env:PATH='C:\\tools'; Set-Location -LiteralPath 'C:\\work tree' -ErrorAction Stop; & 'C:\\O''Brien\\claude.exe' '--resume' 'a$HOME & b'"
  )
})

it('keeps the final Windows environment write after differently cased aliases', () => {
  const command = 'set "CODEX_HOME=C:\\a" & set "Codex_Home=C:\\b" & set "CODEX_HOME=C:\\c" & codex'
  expect(Array.from(readLaunchPosition(command, 'cmd')?.env ?? [])).toEqual([
    ['Codex_Home', 'C:\\b'],
    ['CODEX_HOME', 'C:\\c']
  ])
})

it('keeps the OMP fresh config after a long POSIX system prompt', () => {
  const command = `omp --system-prompt '${'x'.repeat(33_000)}'`
  expect(withFreshOmpLaunch(command, 'posix')).toContain(
    `&& ${command} --config "$ORCA_OMP_FRESH_CONFIG"`
  )
})

it('keeps the OMP fresh config across quoted line breaks and stops at bare line breaks', () => {
  const command = "omp --system-prompt 'line one\nline two'"
  expect(withFreshOmpLaunch(command, 'posix')).toContain(
    '&& omp --system-prompt \'line one\nline two\' --config "$ORCA_OMP_FRESH_CONFIG"'
  )
  const separate = "omp --system-prompt 'line one'\n--profile work"
  expect(withFreshOmpLaunch(separate, 'posix')).toBe(separate)
})
