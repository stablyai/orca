import { describe, expect, it } from 'vitest'
import { providerContextFullFailure } from './provider-context-full'

describe('provider context overflow classification', () => {
  it.each([
    { code: 'contextWindowExceeded' },
    { code: 'ContextWindowExceeded' },
    { code: 'context_length_exceeded' },
    { code: 'context_window_exceeded' },
    { code: 'prompt_too_long' },
    { message: 'prompt is too long: 200001 tokens > 200000 maximum' },
    { code: 'invalid_request_error', status: 400, message: 'Prompt is too long' },
    { message: 'Request size exceeds model context window' },
    { message: "Request exceeds the model's context window." },
    { message: "This model's maximum context length is 128000 tokens. You requested 128001." },
    { message: 'Context window exceeded for this request' },
    { message: "Codex ran out of room in the model's context window" }
  ])('recognizes explicit provider overflow evidence: %j', (error) => {
    expect(providerContextFullFailure(error)).toEqual({ kind: 'contextFull' })
  })

  it.each([
    {},
    { code: 'other' },
    { code: { contextWindowExceeded: {} } },
    { message: { error: 'prompt is too long' } },
    { message: 'The context window is 90% full' },
    { message: 'Please explain why prompt is too long appears in the log' },
    { message: 'An earlier request failed: prompt is too long' },
    { message: 'Maximum output tokens exceeded' },
    { message: 'Token limit exceeded' },
    { message: 'Request too large: maximum body size is 32 MB' },
    { message: 'Input image exceeds the maximum allowed size' },
    { code: 'rate_limit_exceeded', message: 'Prompt is too long for the tokens-per-minute limit' },
    { status: 429, message: 'Prompt is too long' },
    { status: 401, code: 'context_length_exceeded' },
    { code: 'future_error', message: 'Prompt is too long' },
    { message: 'context_length_exceeded' }
  ])('leaves ambiguous or unrelated failures unclassified: %j', (error) => {
    expect(providerContextFullFailure(error)).toBeNull()
  })
})
