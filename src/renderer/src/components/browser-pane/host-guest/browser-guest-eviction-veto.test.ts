import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { BrowserWorkspace } from '../../../../../shared/browser-workspace-types'
import {
  browserTabsVetoGuestEviction,
  selectBrowserGuestEvictionWorktreeIds
} from './browser-guest-worktree-retention'
import { hydrateBrowserDrivers } from '../../../lib/pane-manager/browser-mobile-driver-state'
import { hydrateBrowserRemoteViewerPages } from '../../../lib/pane-manager/browser-remote-viewer-state'
import {
  acquireBrowserAutomationVisibility,
  releaseBrowserAutomationVisibility
} from './browser-automation-visibility'
import { installBrowserPageDownloadActivityTracking } from '../navigate/browser-page-download-activity'

// The retention budget DESTROYS a hidden worktree's guests rather than parking them, so a page a
// paired client is streaming has to veto here too: a destroyed guest kills the screencast for good.
const WATCHED_PAGE = 'page-watched'
const WATCHED_WORKTREE = 'wt-watched'

function tabsFor(pageId: string): BrowserWorkspace[] {
  return [{ id: 'tab-1', pageIds: [pageId] } as unknown as BrowserWorkspace]
}

/** Six over-budget hidden worktrees, so only the veto can spare the watched one. */
function evictionRun(tabs: readonly BrowserWorkspace[]): string[] {
  return selectBrowserGuestEvictionWorktreeIds({
    orderedWorktreeIds: ['wt-a', 'wt-b', 'wt-c', 'wt-d', 'wt-e', WATCHED_WORKTREE],
    activeWorktreeId: 'wt-active',
    isRetained: () => true,
    holdsLiveGuests: () => true,
    isEvictable: (worktreeId) =>
      worktreeId === WATCHED_WORKTREE ? !browserTabsVetoGuestEviction(tabs) : true
  })
}

describe('browser guest eviction veto', () => {
  beforeEach(() => {
    hydrateBrowserDrivers([])
    hydrateBrowserRemoteViewerPages([])
  })

  it('evicts a hidden over-budget worktree no signal is holding', () => {
    expect(browserTabsVetoGuestEviction(tabsFor(WATCHED_PAGE))).toBe(false)
    expect(evictionRun(tabsFor(WATCHED_PAGE))).toContain(WATCHED_WORKTREE)
  })

  it('spares a page a paired client is streaming', () => {
    hydrateBrowserRemoteViewerPages([WATCHED_PAGE])
    expect(evictionRun(tabsFor(WATCHED_PAGE))).not.toContain(WATCHED_WORKTREE)
  })

  it('spares a page a phone is driving', () => {
    hydrateBrowserDrivers([
      { browserPageId: WATCHED_PAGE, driver: { kind: 'mobile', clientId: 'conn-phone' } }
    ])
    expect(evictionRun(tabsFor(WATCHED_PAGE))).not.toContain(WATCHED_WORKTREE)
  })

  it('spares a page an agent is driving through an automation lease', () => {
    const token = acquireBrowserAutomationVisibility(WATCHED_PAGE)
    expect(evictionRun(tabsFor(WATCHED_PAGE))).not.toContain(WATCHED_WORKTREE)
    releaseBrowserAutomationVisibility(token)
    expect(evictionRun(tabsFor(WATCHED_PAGE))).toContain(WATCHED_WORKTREE)
  })

  it('releases the veto when the last remote viewer leaves', () => {
    hydrateBrowserRemoteViewerPages([WATCHED_PAGE])
    expect(browserTabsVetoGuestEviction(tabsFor(WATCHED_PAGE))).toBe(true)
    hydrateBrowserRemoteViewerPages([])
    expect(evictionRun(tabsFor(WATCHED_PAGE))).toContain(WATCHED_WORKTREE)
  })

  // Downloads are the one veto term that is not a paint term: parking a guest keeps the download
  // alive, but eviction unregisters it and main cancels its downloads (tab-close semantics).
  it('spares a page that is still writing a download', () => {
    let emitDownloadRequested: (event: {
      downloadId: string
      browserPageId: string
    }) => void = () => {}
    const noop = (): void => {}
    vi.stubGlobal('window', {
      api: {
        browser: {
          onDownloadRequested: (callback: typeof emitDownloadRequested) => {
            emitDownloadRequested = callback
            return noop
          },
          onDownloadProgress: () => noop,
          onDownloadFinished: () => noop
        }
      }
    })
    const stopDownloadTracking = installBrowserPageDownloadActivityTracking()
    try {
      expect(browserTabsVetoGuestEviction(tabsFor(WATCHED_PAGE))).toBe(false)
      expect(evictionRun(tabsFor(WATCHED_PAGE))).toContain(WATCHED_WORKTREE)

      emitDownloadRequested({ downloadId: 'dl-1', browserPageId: WATCHED_PAGE })
      expect(browserTabsVetoGuestEviction(tabsFor(WATCHED_PAGE))).toBe(true)
      expect(evictionRun(tabsFor(WATCHED_PAGE))).not.toContain(WATCHED_WORKTREE)
    } finally {
      stopDownloadTracking()
      vi.unstubAllGlobals()
    }
  })

  it('holds the veto for a viewer on a non-active page of the same tab', () => {
    const tabs = [
      { id: 'tab-1', activePageId: 'page-front', pageIds: ['page-front', WATCHED_PAGE] }
    ] as unknown as BrowserWorkspace[]
    hydrateBrowserRemoteViewerPages([WATCHED_PAGE])
    expect(evictionRun(tabs)).not.toContain(WATCHED_WORKTREE)
  })
})
