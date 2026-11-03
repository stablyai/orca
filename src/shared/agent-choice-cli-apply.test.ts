import { expect, it } from 'vitest'
import * as startupShell from './tui-agent-startup-shell'
import {
  reconcileAgentChoiceArgs,
  reconcileAgentChoiceArgsDetailed
} from './agent-choice-reconciliation'

const keys = new Set(['model', 'effort', 'permissionMode'])

it('decodes CLI TOML strings and emits type-equivalent config scalars', async () => {
  const { agentChoiceConfigString, agentChoiceCliApply } = await import('./agent-choice-cli-apply')
  const { parse } = await import('smol-toml')
  const apply = agentChoiceCliApply(
    'codex',
    [{ kind: 'config', names: ['-c'], key: 'model_reasoning_effort', lift: 'codex-bare-string' }],
    '-c'
  )
  for (const value of [
    'high',
    'future_effort',
    'true',
    'false',
    '42',
    'inf',
    'some-model',
    'a"b'
  ]) {
    expect(agentChoiceConfigString(JSON.stringify(value))).toBe(value)
    const emitted = apply.launchArgs!(value)[1].split('=').slice(1).join('=')
    expect(agentChoiceConfigString(emitted)).toBe(value)
    let decoded: unknown
    try {
      decoded = parse(`value=${emitted}`).value
    } catch {
      decoded = emitted
    }
    expect(decoded).toBe(value)
  }
  for (const value of [
    'true',
    'false',
    '42',
    '1.0',
    '["high"]',
    '{value="high"}',
    '"high"\nother="lost"'
  ]) {
    expect(agentChoiceConfigString(value)).toBeUndefined()
  }
})

it.each([
  ['model_reasoning_effort="high"', 'effort', 'high'],
  ["model_reasoning_effort='future_effort'", 'effort', 'future_effort'],
  ['model="some-model"', 'model', 'some-model'],
  ['model="true"', 'model', 'true'],
  ['model="42"', 'model', '42']
] as const)(
  'reads %s source independently of native ownership or consumption',
  (operand, key, value) => {
    const userArgs = `-c ${startupShell.quoteStartupArg(operand, 'posix')} --search`
    const result = reconcileAgentChoiceArgsDetailed({
      agent: 'codex',
      userArgs,
      choices: {},
      mode: 'arguments-edit',
      keys
    })
    expect(result.recognized).toMatchObject([{ key, value, source: true, valueType: 'string' }])
    expect(result.analysis.occurrences[0]).toMatchObject({ owned: false, lift: false })
    expect(result.userArgs).toBe(userArgs)
    expect(
      reconcileAgentChoiceArgs({ agent: 'codex', userArgs, choices: {}, mode: 'load', keys })
    ).toEqual({ userArgs, choices: {} })
    expect(key === 'model' ? result.effects.model : result.effects.options?.[key]).toBe(value)
  }
)

it.each(['true', '42', '["high"]', '{key="high"}'])(
  'retains non-string TOML %s without fabricating a source choice',
  (value) => {
    const userArgs = `-c 'model_reasoning_effort=${value}' --search`
    const result = reconcileAgentChoiceArgsDetailed({
      agent: 'codex',
      userArgs,
      choices: {},
      mode: 'arguments-edit',
      keys
    })
    expect(result.recognized).toEqual([])
    expect(result.effects).toEqual({})
    expect(result.userArgs).toBe(userArgs)
  }
)
