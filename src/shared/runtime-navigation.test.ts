import { describe, expect, it } from 'vitest'
import { resolveRuntimeNavigationTarget } from './runtime-navigation'

describe('runtime navigation authority', () => {
  it('denies paired-client fanout for legacy payloads', () => {
    expect(resolveRuntimeNavigationTarget({ clientKind: 'runtime', notifyClients: true })).toBe(
      'caller'
    )
    expect(resolveRuntimeNavigationTarget({ clientKind: 'mobile', notifyClients: true })).toBe(
      'caller'
    )
  })

  it('preserves legacy in-process routing and explicit intent', () => {
    expect(resolveRuntimeNavigationTarget({ notifyClients: true })).toBe('all')
    expect(resolveRuntimeNavigationTarget({ notifyClients: false })).toBe('caller')
    expect(
      resolveRuntimeNavigationTarget({
        clientKind: 'runtime',
        notifyClients: false,
        navigation: 'host'
      })
    ).toBe('host')
  })
})
