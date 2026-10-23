import { describe, expect, it, vi } from 'vitest'
import { createHarnessStoreState, loadIpcEventsHarness } from './ipc-events-test-harness'

type AudioStateEvent = { browserPageId: string; audible: boolean }

// A rebuilt guest (eviction, crash recovery, client-hosted rebind) starts unmuted; main's
// registration report is the renderer's only cue to carry the tab's mute over to it. Local pages
// (e.g. floating browser tabs) still report while a remote environment is active.
describe('browser audio state', () => {
  it('re-applies a muted tab to each reporting page, even with a remote environment active', async () => {
    const setBrowserPageAudible = vi.fn()
    const setPageAudioMuted = vi.fn(() => Promise.resolve(true))
    let audioStateChanged: (event: AudioStateEvent) => void = () => {}
    const harness = await loadIpcEventsHarness(
      createHarnessStoreState({
        tabsByWorktree: {},
        remoteBrowserPageHandlesByPageId: {},
        browserPagesByWorkspace: {
          'tab-muted': [{ id: 'page-muted', workspaceId: 'tab-muted' }],
          'tab-loud': [{ id: 'page-loud', workspaceId: 'tab-loud' }]
        },
        browserAudioMutedTabIds: { 'tab-muted': true },
        setBrowserPageAudible,
        settings: {
          terminalFontSize: 13,
          experimentalNativeChat: false,
          activeRuntimeEnvironmentId: 'env-a'
        }
      }),
      {
        browserApi: {
          onAudioStateChanged: (listener: (event: AudioStateEvent) => void) => {
            audioStateChanged = listener
            return () => {}
          },
          setPageAudioMuted
        }
      }
    )
    harness.useIpcEvents()

    audioStateChanged({ browserPageId: 'page-muted', audible: false })
    audioStateChanged({ browserPageId: 'page-loud', audible: true })

    expect(setBrowserPageAudible).toHaveBeenCalledWith('page-muted', false)
    expect(setBrowserPageAudible).toHaveBeenCalledWith('page-loud', true)
    expect(setPageAudioMuted).toHaveBeenCalledTimes(1)
    expect(setPageAudioMuted).toHaveBeenCalledWith({ browserPageId: 'page-muted', muted: true })
  })
})
