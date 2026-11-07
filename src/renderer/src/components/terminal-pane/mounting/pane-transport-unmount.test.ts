import { describe, expect, it } from 'vitest'
import { shouldDetachPaneTransportOnUnmount } from './pane-transport-unmount'

describe('shouldDetachPaneTransportOnUnmount', () => {
  it('detaches when the tab still owns the transport PTY', () => {
    expect(
      shouldDetachPaneTransportOnUnmount({
        tabStillExists: true,
        tabId: 'tab-1',
        ptyId: 'remote:env@@term-1',
        worktreeTabs: []
      })
    ).toBe(true)
  })

  it('detaches when a mirrored replacement tab owns the same PTY', () => {
    expect(
      shouldDetachPaneTransportOnUnmount({
        tabStillExists: false,
        tabId: 'local-tab',
        ptyId: 'remote:env@@term-1',
        worktreeTabs: [
          {
            id: 'web-terminal-host-tab',
            ptyId: 'remote:env@@term-1',
            worktreeId: 'wt-1',
            title: 'Terminal 1',
            defaultTitle: 'Terminal 1',
            customTitle: null,
            color: null,
            sortOrder: 0,
            createdAt: 1
          }
        ]
      })
    ).toBe(true)
  })

  it('detaches when closeTab already owns provider shutdown for the removed tab', () => {
    expect(
      shouldDetachPaneTransportOnUnmount({
        tabStillExists: false,
        tabId: 'tab-1',
        ptyId: 'remote:env@@term-1',
        worktreeTabs: []
      })
    ).toBe(true)
  })

  it('destroys an ID-less transport so a pending spawn cannot outlive unmount', () => {
    expect(
      shouldDetachPaneTransportOnUnmount({
        tabStillExists: false,
        tabId: 'tab-1',
        ptyId: null,
        worktreeTabs: []
      })
    ).toBe(false)
  })

  it('detaches a removed automation pane after closeTab takes teardown authority', () => {
    expect(
      shouldDetachPaneTransportOnUnmount({
        tabStillExists: false,
        tabId: 'automation-tab',
        ptyId: 'automation-pty',
        worktreeTabs: [
          {
            id: 'unrelated-tab',
            ptyId: 'unrelated-pty',
            worktreeId: 'wt-1',
            title: 'Terminal 1',
            customTitle: null,
            color: null,
            sortOrder: 0,
            createdAt: 1
          }
        ]
      })
    ).toBe(true)
  })
})
