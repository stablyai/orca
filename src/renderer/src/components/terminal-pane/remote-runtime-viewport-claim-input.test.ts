import { describe, expect, it } from 'vitest'
import { createRemoteRuntimeViewportClaimInput } from './remote-runtime-viewport-claim-input'

describe('remote runtime viewport-claim input', () => {
  it('preserves accepted input order and resets its byte charge on take', () => {
    const input = createRemoteRuntimeViewportClaimInput(4)

    expect(input.append('ab')).toBe(true)
    expect(input.append('cd')).toBe(true)
    expect(input.take()).toBe('abcd')
    expect(input.append('next')).toBe(true)
  })

  it('rejects producer backlog before concatenating beyond the byte budget', () => {
    const input = createRemoteRuntimeViewportClaimInput(4)

    expect(input.append('é')).toBe(true)
    expect(input.append('ab')).toBe(true)
    expect(input.append('!')).toBe(false)
    expect(input.take()).toBe('éab')
  })
})
