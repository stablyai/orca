import { describe, expect, it } from 'vitest'
import { parseOpenCodeGenerationOutput } from './opencode-generation-output'

const frame = (type: string, text: string, id = 'answer'): string =>
  JSON.stringify({ type, part: { id, text } })

describe('OpenCode generation event output', () => {
  it('uses the final answer after a tool step', () => {
    const output = [
      frame('step_start', ''),
      frame('text', 'I will inspect the staged diff.'),
      frame('tool_use', 'git diff'),
      frame('step_finish', 'tool-calls'),
      frame('step_start', ''),
      frame('text', 'fix: parse the final answer')
    ].join('\n')
    expect(parseOpenCodeGenerationOutput(output)).toEqual({
      ok: true,
      text: 'fix: parse the final answer'
    })
  })
  it('keeps assistant text and ignores tool, reasoning, progress and warning events', () => {
    const output = [
      frame('step_start', 'starting'),
      frame('reasoning', 'reasoning'),
      frame('tool_use', 'git diff output'),
      JSON.stringify({ type: 'warning', message: 'notice' }),
      frame('text', 'fix: generate messages'),
      frame('step_finish', 'done')
    ].join('\n')
    expect(parseOpenCodeGenerationOutput(output)).toEqual({
      ok: true,
      text: 'fix: generate messages'
    })
  })

  it('replaces repeated parts and preserves multiple answer parts', () => {
    expect(
      parseOpenCodeGenerationOutput(
        [frame('text', 'partial'), frame('text', 'subject'), frame('text', 'body', 'body')].join(
          '\r\n'
        )
      )
    ).toEqual({ ok: true, text: 'subject\nbody' })
  })

  it.each([
    { name: 'UnknownError', data: { message: 'Model unavailable' } },
    { type: 'provider.no-route', message: 'Unsupported package' }
  ])('reports errors instead of accepting a partial answer', (error) => {
    const output = `${frame('text', 'partial')}\n${JSON.stringify({ type: 'error', error })}`
    expect(parseOpenCodeGenerationOutput(output)).toEqual({
      ok: false,
      error: error.message ?? error.data?.message
    })
  })

  it.each([
    { error: { name: 'MessageOutputLengthError', data: {} }, expected: 'MessageOutputLengthError' },
    {
      error: { name: 'ProviderError', data: { retryable: false } },
      expected: 'ProviderError'
    },
    {
      error: { name: 'ProviderError', message: 'Provider rejected the request', data: {} },
      expected: 'Provider rejected the request'
    }
  ])('reports named errors without a data message', ({ error, expected }) => {
    const output = `${frame('text', 'partial')}\n${JSON.stringify({ type: 'error', error })}`
    expect(parseOpenCodeGenerationOutput(output)).toEqual({ ok: false, error: expected })
  })

  it.each([
    '{broken',
    '{"title":"not an event"}',
    'null',
    JSON.stringify({ type: 'error', error: { name: 'ProviderError', data: { message: 42 } } })
  ])('rejects malformed events %s', (output) => {
    expect(parseOpenCodeGenerationOutput(output)).toEqual({
      ok: false,
      error: 'OpenCode returned invalid JSON events.'
    })
  })
})
