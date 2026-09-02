import { describe, expect, it } from 'vitest'
import { parseClaudeModelList } from './claude-model-list-probe'

function controlResponseLine(models: unknown[]): string {
  return JSON.stringify({
    type: 'control_response',
    response: {
      subtype: 'success',
      request_id: 'orca-model-discovery',
      response: { models }
    }
  })
}

// Captured from `claude` 2.1.220 answering a list_models control request.
const LIVE_MODELS = [
  {
    value: 'default',
    resolvedModel: 'claude-opus-5[1m]',
    displayName: 'Default (recommended)',
    description: 'Use the default model (currently Opus 5 (1M context)) · $5/$25 per Mtok',
    supportsEffort: true,
    supportedEffortLevels: ['low', 'medium', 'high', 'xhigh', 'max'],
    supportsFastMode: true
  },
  {
    value: 'opus[1m]',
    resolvedModel: 'claude-opus-5[1m]',
    displayName: 'Opus (1M context)',
    description: 'Opus 5 with 1M context · Best for everyday, complex tasks · $5/$25 per Mtok',
    supportsEffort: true,
    supportedEffortLevels: ['low', 'medium', 'high', 'xhigh', 'max'],
    supportsFastMode: true
  },
  {
    value: 'sonnet',
    resolvedModel: 'claude-sonnet-5',
    displayName: 'Sonnet',
    description: 'Sonnet 5 · Efficient for routine tasks · $2/$10 per Mtok',
    supportsEffort: true,
    supportedEffortLevels: ['low', 'medium', 'high', 'xhigh', 'max'],
    supportsAdaptiveThinking: true
  },
  {
    value: 'haiku',
    resolvedModel: 'claude-haiku-4-5-20251001',
    displayName: 'Haiku',
    description: 'Haiku 4.5 · Fastest for quick answers · $1/$5 per Mtok'
  }
]

describe('parseClaudeModelList', () => {
  it('parses the picker catalog and drops the mirror default row', () => {
    const parsed = parseClaudeModelList(`${controlResponseLine(LIVE_MODELS)}\n`)
    expect(parsed.map(({ id }) => id)).toEqual(['opus[1m]', 'sonnet', 'haiku'])
    expect(parsed[0]).toEqual({
      id: 'opus[1m]',
      label: 'Opus (1M context)',
      description: 'Opus 5 with 1M context · Best for everyday, complex tasks · $5/$25 per Mtok',
      effortLevels: ['low', 'medium', 'high', 'xhigh', 'max'],
      supportsFastMode: true
    })
    expect(parsed[2]).toMatchObject({ effortLevels: [], supportsFastMode: false })
  })

  it('skips init noise, CRLF endings, and duplicate values', () => {
    const stdout =
      '{"type":"system","subtype":"init","model":"claude-sonnet-5"}\r\n' +
      'not json at all\r\n' +
      `${controlResponseLine([
        { value: 'sonnet', displayName: 'Sonnet' },
        { value: 'sonnet', displayName: 'Sonnet (duplicate)' },
        { value: '  ', displayName: 'Blank' }
      ])}\r\n`
    expect(parseClaudeModelList(stdout)).toEqual([
      { id: 'sonnet', label: 'Sonnet', effortLevels: [], supportsFastMode: false }
    ])
  })

  it('skips non-object model entries instead of failing the discovery response', () => {
    const stdout = controlResponseLine([null, 7, [], { value: 'sonnet', displayName: 'Sonnet' }])
    expect(parseClaudeModelList(stdout)).toEqual([
      { id: 'sonnet', label: 'Sonnet', effortLevels: [], supportsFastMode: false }
    ])
  })

  it('returns no models for the control error emitted by CLIs without list_models', () => {
    // Captured from `claude` 2.1.100: unsupported subtype still exits 0.
    const stdout =
      '{"type":"control_response","response":{"subtype":"error","request_id":"orca-model-discovery","error":"Unsupported control request subtype: list_models"}}\n'
    expect(parseClaudeModelList(stdout)).toEqual([])
  })

  it('returns no models for empty, malformed, or structurally hostile output', () => {
    expect(parseClaudeModelList('')).toEqual([])
    expect(parseClaudeModelList('{"type":"control_response"')).toEqual([])
    expect(
      parseClaudeModelList(
        `{"type":"control_response","response":{"subtype":"success","response":{"models":${'['.repeat(64)}${']'.repeat(64)}}}}`
      )
    ).toEqual([])
    const hostile = `{"a":${'['.repeat(40)}${']'.repeat(40)},"type":"control_response"}`
    expect(parseClaudeModelList(hostile)).toEqual([])
  })

  it('drops the disabled placeholder row the CLI advertises for a model it cannot run', () => {
    // Captured from `claude` 2.1.237: Fable 5.1 is announced but gated on 2.1.255+.
    const parsed = parseClaudeModelList(
      controlResponseLine([
        { value: 'sonnet', displayName: 'Sonnet' },
        {
          value: 'cc-update-required-1',
          resolvedModel: 'cc-update-required-1',
          displayName: 'Fable 5.1 (disabled)',
          description: 'Update to 2.1.255+ to use Fable 5.1',
          supportsEffort: true,
          supportedEffortLevels: ['low', 'medium', 'high', 'xhigh', 'max'],
          disabled: true
        }
      ])
    )
    expect(parsed.map(({ id }) => id)).toEqual(['sonnet'])
  })

  it('keeps a model that reports disabled as anything other than true', () => {
    const parsed = parseClaudeModelList(
      controlResponseLine([{ value: 'fable', displayName: 'Fable', disabled: false }])
    )
    expect(parsed.map(({ id }) => id)).toEqual(['fable'])
  })

  it('ignores effort levels when the model does not declare effort support', () => {
    const parsed = parseClaudeModelList(
      controlResponseLine([
        { value: 'haiku', displayName: 'Haiku', supportedEffortLevels: ['low', 'high'] }
      ])
    )
    expect(parsed[0]?.effortLevels).toEqual([])
  })
})
