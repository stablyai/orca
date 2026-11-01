import { describe, expect, it, vi } from 'vitest'

vi.mock('@/store', async () => {
  const { create } = await import('zustand')
  return {
    useAppStore: create(() => {
      const wslHostStatuses: Record<string, { state: WslHostConnectionState }> = {}
      return { runtimeStatusByEnvironmentId: new Map(), runtimeEnvironments: [], wslHostStatuses }
    })
  }
})

import { useAppStore } from '@/store'
import { subscribeRuntimeHostContactRegained } from './runtime-host-contact-regained'
import type { WslHostConnectionState } from '../../../shared/wsl-host-types'

function wslHost(state: WslHostConnectionState): void {
  useAppStore.setState({
    wslHostStatuses: {
      'wsl:ubuntu': { environmentId: 'wsl:ubuntu', distro: 'Ubuntu', state, detail: null }
    }
  })
}

// QA F1: after a relaunch the runtime status stayed verified while the WSL host connected, so
// panels that loaded before it never heard the host was back.
describe('regaining a WSL host', () => {
  it('counts the host becoming ready, once per return', () => {
    wslHost('connecting')
    const listener = vi.fn()
    const stop = subscribeRuntimeHostContactRegained('wsl:ubuntu', listener)

    wslHost('ready')
    expect(listener).toHaveBeenCalledOnce()
    wslHost('ready')
    expect(listener).toHaveBeenCalledOnce()

    wslHost('distro-stopped')
    expect(listener).toHaveBeenCalledOnce()
    wslHost('ready')
    expect(listener).toHaveBeenCalledTimes(2)
    stop()
  })
})
