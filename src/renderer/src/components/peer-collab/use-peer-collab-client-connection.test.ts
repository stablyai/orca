// @vitest-environment happy-dom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { act, renderHook } from '@testing-library/react'
import type { PeerClientStatusWithHost } from '../../../../shared/peer-client-status'
import { usePeerCollabClientConnection } from './use-peer-collab-client-connection'

function status(
  hostId: string,
  state: PeerClientStatusWithHost['state']
): PeerClientStatusWithHost {
  return { hostId, state, endpoint: `${hostId}.local`, reconnectAttempt: 0, lastErrorReason: null }
}

describe('usePeerCollabClientConnection', () => {
  let onStatusChangedCallback: ((status: PeerClientStatusWithHost) => void) | null = null
  const unsubscribeStatusChanged = vi.fn()
  const disconnect = vi.fn(() => Promise.resolve({ ok: true as const }))
  const listHostTerminals = vi.fn((args: { hostId: string }) =>
    Promise.resolve({
      ok: true as const,
      terminals: { terminals: [{ handle: `${args.hostId}-t1`, title: null, tabId: 't1' }] }
    })
  )

  beforeEach(() => {
    vi.useFakeTimers()
    onStatusChangedCallback = null
    unsubscribeStatusChanged.mockClear()
    disconnect.mockClear()
    listHostTerminals.mockClear()
    ;(window as unknown as { api: unknown }).api = {
      peerClient: {
        getStatuses: () => Promise.resolve([]),
        getDefaultDisplayName: () => Promise.resolve({ name: 'tester' }),
        onStatusChanged: (callback: (status: PeerClientStatusWithHost) => void) => {
          onStatusChangedCallback = callback
          return unsubscribeStatusChanged
        },
        listHostTerminals,
        disconnect,
        listSavedPairings: () => Promise.resolve([]),
        getHostNames: () => Promise.resolve({ names: {} }),
        setHostName: () => Promise.resolve({ names: {} }),
        connectSaved: () => Promise.resolve({ ok: true as const, hostId: 'unused' })
      }
    }
  })

  afterEach(() => {
    vi.useRealTimers()
    delete (window as unknown as { api?: unknown }).api
  })

  it('polls terminals independently per connected host and tears down on disconnect', async () => {
    const { result, unmount } = renderHook(() => usePeerCollabClientConnection())

    await act(async () => {
      onStatusChangedCallback?.(status('host-a', 'connected'))
      onStatusChangedCallback?.(status('host-b', 'connected'))
    })

    await act(async () => {
      await vi.advanceTimersByTimeAsync(3000)
    })

    expect(listHostTerminals).toHaveBeenCalledWith({ hostId: 'host-a' })
    expect(listHostTerminals).toHaveBeenCalledWith({ hostId: 'host-b' })

    await act(async () => {
      await Promise.resolve()
      await Promise.resolve()
    })
    const hostA = result.current.hosts.find((h) => h.hostId === 'host-a')
    const hostB = result.current.hosts.find((h) => h.hostId === 'host-b')
    expect(hostA?.terminals).toEqual([{ handle: 'host-a-t1', title: null, tabId: 't1' }])
    expect(hostB?.terminals).toEqual([{ handle: 'host-b-t1', title: null, tabId: 't1' }])

    listHostTerminals.mockClear()
    await act(async () => {
      await result.current.disconnectAsClient('host-a')
    })

    expect(disconnect).toHaveBeenCalledWith({ hostId: 'host-a' })
    expect(result.current.hosts.find((h) => h.hostId === 'host-a')).toBeUndefined()
    expect(result.current.hosts.find((h) => h.hostId === 'host-b')).toBeDefined()

    await act(async () => {
      await vi.advanceTimersByTimeAsync(3000)
    })
    expect(listHostTerminals).toHaveBeenCalledWith({ hostId: 'host-b' })
    expect(listHostTerminals).not.toHaveBeenCalledWith({ hostId: 'host-a' })

    unmount()
  })

  it('stops polling once every host disconnects', async () => {
    const { result } = renderHook(() => usePeerCollabClientConnection())

    await act(async () => {
      onStatusChangedCallback?.(status('host-a', 'connected'))
    })
    await act(async () => {
      await vi.advanceTimersByTimeAsync(3000)
    })
    listHostTerminals.mockClear()

    await act(async () => {
      await result.current.disconnectAsClient('host-a')
    })
    await act(async () => {
      await vi.advanceTimersByTimeAsync(9000)
    })

    expect(listHostTerminals).not.toHaveBeenCalled()
  })
})
