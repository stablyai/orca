import { expect, it } from 'vitest'

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
