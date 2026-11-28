// @vitest-environment happy-dom
import { act, cleanup, renderHook, waitFor } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { BrowserClientHostViewerChangedEvent } from '../../../../../shared/browser/client-hosting/browser-client-host-placement'
import { useClientHostViewer } from './use-client-host-viewer'

// Main's side: a pull read and the push channel it publishes record/release on.
let mainViewer: 'teammate' | 'own-computer' | null = null
let settleRead: (() => void) | null = null
const listeners = new Set<(event: BrowserClientHostViewerChangedEvent) => void>()
const read = vi.fn(
  () =>
    new Promise<typeof mainViewer>((resolve) => {
      const answer = mainViewer
      settleRead = () => resolve(answer)
    })
)
Object.defineProperty(window, 'api', {
  value: {
    runtimeEnvironments: {
      browserClientHostViewer: read,
      onBrowserClientHostViewerChanged: (
        listener: (event: BrowserClientHostViewerChangedEvent) => void
      ) => {
        listeners.add(listener)
        return () => listeners.delete(listener)
      }
    }
  },
  configurable: true
})
const publish = (event: BrowserClientHostViewerChangedEvent): void =>
  act(() => listeners.forEach((listener) => listener(event)))

afterEach(() => {
  cleanup()
  listeners.clear()
  mainViewer = null
  settleRead = null
})

describe('useClientHostViewer', () => {
  it('stays unknown before the host starts, then takes the viewer main pushes', async () => {
    const { result } = renderHook(() => useClientHostViewer('env'))
    await act(async () => settleRead?.())
    expect(result.current).toBe('unknown')

    publish({ environmentId: 'other', viewer: 'own-computer' })
    expect(result.current).toBe('unknown')
    publish({ environmentId: 'env', viewer: 'teammate' })
    expect(result.current).toBe('teammate')
  })

  it('lets a push that lands mid-read win over the stale read', async () => {
    const { result } = renderHook(() => useClientHostViewer('env'))
    publish({ environmentId: 'env', viewer: 'teammate' })
    await act(async () => settleRead?.())
    expect(result.current).toBe('teammate')
  })

  it('goes back to unknown when the host is released', async () => {
    mainViewer = 'own-computer'
    const { result } = renderHook(() => useClientHostViewer('env'))
    await act(async () => settleRead?.())
    await waitFor(() => expect(result.current).toBe('own-computer'))
    publish({ environmentId: 'env', viewer: null })
    expect(result.current).toBe('unknown')
  })
})
