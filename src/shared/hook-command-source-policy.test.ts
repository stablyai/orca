import { describe, expect, it } from 'vitest'
import { resolveHookCommandSourcePolicy } from './hook-command-source-policy'

describe('hook command source policy', () => {
  it('uses local commands by default when a local script is configured', () => {
    expect(resolveHookCommandSourcePolicy(undefined, { hasLocalScript: true })).toBe('local-only')
  })

  it('uses shared commands by default when no local script is configured', () => {
    expect(resolveHookCommandSourcePolicy(undefined, { hasLocalScript: false })).toBe('shared-only')
  })

  it('preserves explicit command source choices', () => {
    expect(resolveHookCommandSourcePolicy('shared-only', { hasLocalScript: true })).toBe(
      'shared-only'
    )
    expect(resolveHookCommandSourcePolicy('run-both', { hasLocalScript: true })).toBe('run-both')
  })
})
