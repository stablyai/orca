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
  it('drops the disabled placeholder row the CLI advertises for a model it cannot run', () => {
    const parsed = parseClaudeModelList(
      controlResponseLine([{ value: 'sonnet' }, { value: 'disabled-model', disabled: true }])
    )
    expect(parsed.map(({ id }) => id)).toEqual(['sonnet'])
  })
})
