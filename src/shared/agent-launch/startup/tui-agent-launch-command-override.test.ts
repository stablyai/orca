import { planAgentBinary } from './agent-command-plan'
import { describe, expect, it } from 'vitest'
import { structuredAgentCommandPlan } from './tui-agent-launch-command-override'

describe('structured agent command tokens', () => {
  it.each([
    ['claude-nightly', 'claude-nightly'],
    ['/opt/tools/claude', '/opt/tools/claude'],
    ['"/opt/my tools/claude"', '/opt/my tools/claude'],
    [String.raw`/opt/my\ tools/claude`, '/opt/my tools/claude'],
    [
      String.raw`"C:\Program Files\Claude\claude.exe"`,
      String.raw`C:\Program Files\Claude\claude.exe`
    ],
    ['~/bin/codex', '~/bin/codex']
  ])('accepts one literal executable %s', (input, token) => {
    expect(structuredAgentCommandPlan(input)).toEqual({ program: token, prefixArgs: [] })
  })

  it.each([
    'FOO=1 claude',
    'env claude | cat',
    'env --config=$SECRET claude',
    'env `command` claude',
    'env claude # comment',
    'env * claude',
    'claude;codex',
    '$CLI',
    '"$HOME/bin/claude"',
    '`which claude`',
    'claude | cat',
    'claude\ncodex',
    '"unfinished'
  ])('rejects shell syntax %s', (command) => {
    expect(structuredAgentCommandPlan(command)).toBeNull()
  })
})

it('shares literal prefix splitting while commit messages retain their environment and shell-character acceptance', () => {
  expect(
    structuredAgentCommandPlan('op run --env-file="work env" -- codex --profile work')
  ).toEqual({
    program: 'op',
    prefixArgs: ['run', '--env-file=work env', '--', 'codex', '--profile', 'work']
  })
  expect(planAgentBinary('codex', 'FOO=1 launcher "$HOME" "*"')).toEqual({
    ok: true,
    binary: 'launcher',
    prefixArgs: ['$HOME', '*'],
    env: { FOO: '1' }
  })
})

it.each(['op.exe', String.raw`"C:\Tools\op.exe"`, String.raw`"\\server\tools\op.exe"`])(
  'preserves Windows prefix paths independently of the executable spelling %s',
  (program) => {
    expect(
      structuredAgentCommandPlan(
        `${program} run --env-file="C:\\Users\\dev\\work env.env" -- node C:\\Tools\\launcher.mjs codex`,
        'win32'
      )?.prefixArgs
    ).toEqual([
      'run',
      String.raw`--env-file=C:\Users\dev\work env.env`,
      '--',
      'node',
      String.raw`C:\Tools\launcher.mjs`,
      'codex'
    ])
  }
)

it.each(['linux', 'darwin'] as const)('keeps POSIX escaping on a %s execution host', (platform) => {
  expect(
    structuredAgentCommandPlan(String.raw`op run --env-file=work\ env -- codex`, platform)
  ).toEqual({
    program: 'op',
    prefixArgs: ['run', '--env-file=work env', '--', 'codex']
  })
})
