// @vitest-environment happy-dom

import { cleanup, renderHook, waitFor } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { PluginRemotePanelBinding } from '../../../../../shared/plugins/frames/plugin-remote-panel'

vi.mock('@/store/plugins/frames/plugin-frame-isolation', () => ({
  notePluginFrameIsolation: () => undefined
}))

import { usePluginFrameEntry } from './use-plugin-frame-entry'

const TOKEN = 't'.repeat(43)

afterEach(() => {
  cleanup()
  vi.unstubAllGlobals()
})

describe('usePluginFrameEntry on a paired host', () => {
  it('binds a session once across overlapping reads and releases it once', async () => {
    let refresh: () => void = () => undefined
    let finishBind: (binding: PluginRemotePanelBinding) => void = () => undefined
    const bindRemotePanel = vi.fn(
      () =>
        new Promise<PluginRemotePanelBinding>((resolve) => {
          finishBind = resolve
        })
    )
    const unbindRemotePanel = vi.fn().mockResolvedValue(undefined)
    const read = Promise.resolve({ html: '<p>notes</p>', sessionToken: TOKEN })
    vi.stubGlobal('api', {
      plugins: {
        readPanelEntry: () => read,
        onChanged: (listener: () => void) => {
          refresh = listener
          return () => undefined
        },
        bindRemotePanel,
        unbindRemotePanel
      }
    })
    const { result, unmount } = renderHook(() =>
      usePluginFrameEntry('panel', 'acme.notes', 'main', 'env-1')
    )
    await waitFor(() => expect(bindRemotePanel).toHaveBeenCalled())

    // A plugin change starts a second read while the first bind is still in flight.
    refresh()
    await read
    finishBind({ bound: true, hostName: 'work-mac', bindingId: 1 })

    await waitFor(() =>
      expect(result.current.entry).toMatchObject({
        status: 'ready',
        host: { kind: 'paired', name: 'work-mac' }
      })
    )
    expect(bindRemotePanel).toHaveBeenCalledTimes(1)
    unmount()
    await waitFor(() => expect(unbindRemotePanel).toHaveBeenCalledTimes(1))
    expect(unbindRemotePanel).toHaveBeenCalledWith({ sessionToken: TOKEN, bindingId: 1 })
  })
  it('reads again when the host closes the panel before its bind answer arrives', async () => {
    const [first, second] = ['a'.repeat(43), 'b'.repeat(43)]
    const reads = [first, second]
    let finishFirstBind: (binding: PluginRemotePanelBinding) => void = () => undefined
    let closed: (sessionToken: string) => void = () => undefined
    const bindRemotePanel = vi
      .fn()
      .mockImplementationOnce(
        () =>
          new Promise<PluginRemotePanelBinding>((resolve) => {
            finishFirstBind = resolve
          })
      )
      .mockResolvedValue({ bound: true, hostName: 'work-mac', bindingId: 2 })
    vi.stubGlobal('api', {
      plugins: {
        readPanelEntry: () =>
          Promise.resolve({ html: '<p>notes</p>', sessionToken: reads.shift() ?? second }),
        onRemotePanelClosed: (listener: (sessionToken: string) => void) => {
          closed = listener
          return () => undefined
        },
        bindRemotePanel,
        unbindRemotePanel: vi.fn().mockResolvedValue(undefined)
      }
    })
    const tokensShown: (string | null)[] = []
    const { result } = renderHook(() => {
      const state = usePluginFrameEntry('panel', 'acme.notes', 'main', 'env-1')
      if (state.entry.status === 'ready') {
        tokensShown.push(state.entry.sessionToken)
      }
      return state
    })
    await waitFor(() => expect(bindRemotePanel).toHaveBeenCalledTimes(1))

    // The host sent ready and then end: main's close notice beats its bind answer here.
    closed(first)
    finishFirstBind({ bound: true, hostName: 'work-mac', bindingId: 1 })

    await waitFor(() =>
      expect(result.current.entry).toMatchObject({
        status: 'ready',
        sessionToken: second,
        host: { kind: 'paired', name: 'work-mac' }
      })
    )
    expect(bindRemotePanel).toHaveBeenLastCalledWith({
      sessionToken: second,
      environmentId: 'env-1'
    })
    expect(tokensShown).not.toContain(first)
  })
})
