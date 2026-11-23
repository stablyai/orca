// #46567: a caller's background tag may add background, never cancel what the params say.
import { describe, expect, it } from 'vitest'
import { isBackgroundRuntimeCall } from './runtime-rpc-background-read'

describe('whether a runtime call is background', () => {
  it('keeps an unselected discovery read background when its caller tags it false', () => {
    expect(isBackgroundRuntimeCall(false, { branch: 'main', admissionTier: 'background' })).toBe(
      true
    )
    expect(isBackgroundRuntimeCall(undefined, { reason: 'swr' })).toBe(true)
  })

  it('treats a user read as use unless tagged', () => {
    expect(isBackgroundRuntimeCall(false, { admissionTier: 'interactive' })).toBe(false)
    expect(isBackgroundRuntimeCall(undefined, { reason: 'swr', userRefresh: true })).toBe(false)
    expect(isBackgroundRuntimeCall(true, { admissionTier: 'interactive' })).toBe(true)
  })
})
