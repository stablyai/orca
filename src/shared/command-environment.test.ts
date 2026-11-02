import { describe, expect, it } from 'vitest'
import { extractLeadingEnvAssignments, mergeCommandEnvironment } from './command-environment'
import { planAgentBinary, planCommitMessageGeneration } from './commit-message-plan'
import { planCustomCommand } from './commit-message-prompt'

describe('command environment assignments', () => {
  it('parses only leading valid names and retains literal values', () => {
    expect(extractLeadingEnvAssignments(['A=x=y', '_EMPTY=', 'agent', 'B=later'])).toEqual({
      env: { A: 'x=y', _EMPTY: '' },
      rest: ['agent', 'B=later']
    })
    for (const name of ['1BAD=x', 'BAD-NAME=x', '=empty']) {
      expect(extractLeadingEnvAssignments([name, 'agent'])).toEqual({ rest: [name, 'agent'] })
    }
  })

  it('uses the real binary for presets and custom commands without expanding expressions', () => {
    expect(planAgentBinary('claude', 'FLAG=1 npx claude')).toEqual({
      ok: true,
      binary: 'npx',
      prefixArgs: ['claude'],
      env: { FLAG: '1' }
    })
    expect(
      planCustomCommand('VALUE="a b=$HOME;$(echo unsafe)" agent KEY=arg {prompt}', 'hello')
    ).toEqual({
      ok: true,
      binary: 'agent',
      args: ['KEY=arg', 'hello'],
      stdinPayload: null,
      env: { VALUE: 'a b=$HOME;$(echo unsafe)' }
    })
    expect(
      planCommitMessageGeneration(
        { agentId: 'claude', model: 'sonnet', agentCommandOverride: 'FLAG=1 claude' },
        'hello'
      )
    ).toMatchObject({ ok: true, plan: { binary: 'claude', env: { FLAG: '1' } } })
  })

  it('rejects assignment-only commands and preserves no-prefix plans', () => {
    expect(planAgentBinary('claude', 'ONLY=env')).toMatchObject({ ok: false })
    expect(planCustomCommand('ONLY=env', 'prompt')).toMatchObject({ ok: false })
    expect(planCustomCommand('agent', 'prompt')).toEqual({
      ok: true,
      binary: 'agent',
      args: [],
      stdinPayload: 'prompt'
    })
  })

  it('keeps Windows paths and empty or prototype-named values intact', () => {
    const result = planCustomCommand(
      'DIR="C:\\my dir" __proto__=data "C:\\bin\\agent.exe"',
      'prompt',
      'literal'
    )
    expect(result).toMatchObject({
      ok: true,
      binary: 'C:\\bin\\agent.exe',
      env: { DIR: 'C:\\my dir' }
    })
    if (result.ok) {
      expect(Object.getOwnPropertyDescriptor(result.env, '__proto__')?.value).toBe('data')
    }
  })

  it('lets the last assignment override every Windows spelling without mutating the base', () => {
    const base = { PATH: 'old', Path: 'also old', TOKEN: 'old', KEEP: 'keep', ComSpec: 'cmd.exe' }
    const { env } = extractLeadingEnvAssignments([
      'Path=first',
      'PATH=second',
      'Path=last',
      'token=',
      'agent'
    ])
    expect(mergeCommandEnvironment(base, env, 'win32')).toEqual({
      PATH: 'last',
      TOKEN: '',
      KEEP: 'keep',
      COMSPEC: 'cmd.exe'
    })
    expect(base.PATH).toBe('old')
    expect(mergeCommandEnvironment({ PATH: 'old' }, { Path: 'new' }, 'linux')).toEqual({
      PATH: 'old',
      Path: 'new'
    })
    expect(mergeCommandEnvironment(undefined, undefined, 'darwin')).toBeUndefined()
  })
})
