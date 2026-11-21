// @vitest-environment happy-dom

import { act, renderHook } from '@testing-library/react'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { MobilePairingConnectionMode } from '../../../../shared/remote-runtime/pairing/mobile-pairing-connection-mode'

type StoreState = {
  settings: { mobilePairingConnectionMode: MobilePairingConnectionMode }
  orcaProfileAuthStatus: { state: 'local' | 'connected' }
}

const mocks = vi.hoisted(() => {
  const state: StoreState = {
    settings: { mobilePairingConnectionMode: 'local-only' },
    orcaProfileAuthStatus: { state: 'local' }
  }
  return { state }
})

vi.mock('@/store', () => ({
  useAppStore: (selector: (state: StoreState) => unknown) => selector(mocks.state)
}))

import { useMobilePairingConnectionMode } from './use-mobile-pairing-connection-mode'

describe('useMobilePairingConnectionMode', () => {
  beforeEach(() => {
    mocks.state = {
      settings: { mobilePairingConnectionMode: 'local-only' },
      orcaProfileAuthStatus: { state: 'local' }
    }
  })

  it('keeps Relay when a signed-out user picks it after having saved LAN', () => {
    const { result, rerender } = renderHook(() => useMobilePairingConnectionMode())
    expect(result.current[0]).toBe('local-only')

    act(() => result.current[1]('automatic'))
    mocks.state = { ...mocks.state, settings: { mobilePairingConnectionMode: 'automatic' } }
    rerender()

    expect(result.current[0]).toBe('automatic')
  })
})
