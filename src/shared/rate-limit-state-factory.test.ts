import { describe, expect, it } from 'vitest'
import { createEmptyRateLimitState } from './rate-limit-state-factory'

describe('createEmptyRateLimitState', () => {
  it('initializes Zhipu state and credential visibility', () => {
    expect(createEmptyRateLimitState()).toMatchObject({
      zhipu: null,
      zhipuCredentialsConfigured: false
    })
  })
})
