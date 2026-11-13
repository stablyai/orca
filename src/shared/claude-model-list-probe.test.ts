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

describe('parseClaudeModelList', () => {
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
})
