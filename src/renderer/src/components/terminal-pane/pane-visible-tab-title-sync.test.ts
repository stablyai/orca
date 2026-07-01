import { describe, expect, it, vi } from 'vitest'

import { syncPaneVisibleTabTitle } from './pane-visible-tab-title-sync'

describe('syncPaneVisibleTabTitle', () => {
  it('uses accepted authoritative pane titles over later raw OSC 2 titles for focus sync', () => {
    const updateTabTitle = vi.fn()

    syncPaneVisibleTabTitle({
      state: {
        acceptedPaneTabTitlesByTabId: {
          'tab-1': {
            2: { title: 'Claude session title', source: 'authoritative-tab' }
          }
        },
        runtimePaneTitlesByTabId: {
          'tab-1': {
            2: 'Shell window title'
          }
        }
      },
      tabId: 'tab-1',
      paneId: 2,
      updateTabTitle
    })

    expect(updateTabTitle).toHaveBeenCalledWith(
      'tab-1',
      'Claude session title',
      'authoritative-tab'
    )
  })

  it('uses the same accepted title for close-survivor sync', () => {
    const updateTabTitle = vi.fn()

    syncPaneVisibleTabTitle({
      state: {
        acceptedPaneTabTitlesByTabId: {
          'tab-1': {
            1: { title: 'Surviving Claude title', source: 'authoritative-tab' }
          }
        },
        runtimePaneTitlesByTabId: {
          'tab-1': {
            1: 'Surviving shell window'
          }
        }
      },
      tabId: 'tab-1',
      paneId: 1,
      updateTabTitle
    })

    expect(updateTabTitle).toHaveBeenCalledWith(
      'tab-1',
      'Surviving Claude title',
      'authoritative-tab'
    )
  })

  it('falls back to raw runtime titles as legacy window fallback when no accepted title exists', () => {
    const updateTabTitle = vi.fn()

    syncPaneVisibleTabTitle({
      state: {
        acceptedPaneTabTitlesByTabId: {},
        runtimePaneTitlesByTabId: {
          'tab-1': {
            1: 'Shell window title'
          }
        }
      },
      tabId: 'tab-1',
      paneId: 1,
      updateTabTitle
    })

    expect(updateTabTitle).toHaveBeenCalledWith(
      'tab-1',
      'Shell window title',
      'legacy-window-fallback'
    )
  })
})
