import { expect, it } from 'vitest'
import { isLocalLinearAttentionSource } from './attention-routing'

it('allows local project sources independently of the selected execution host', () => {
  expect(
    isLocalLinearAttentionSource({ hostId: 'local' }, { activeRuntimeEnvironmentId: 'remote' })
  ).toBe(true)
  expect(isLocalLinearAttentionSource(null, { activeRuntimeEnvironmentId: null })).toBe(true)
})
it('never falls back to local personal credentials for SSH relay or paired runtime sources', () => {
  expect(
    isLocalLinearAttentionSource({ hostId: 'ssh:relay' }, { activeRuntimeEnvironmentId: null })
  ).toBe(false)
  expect(
    isLocalLinearAttentionSource({ hostId: 'runtime:paired' }, { activeRuntimeEnvironmentId: null })
  ).toBe(false)
  expect(isLocalLinearAttentionSource(null, { activeRuntimeEnvironmentId: 'paired' })).toBe(false)
})
