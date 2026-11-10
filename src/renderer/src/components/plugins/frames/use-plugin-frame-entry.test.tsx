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
})
