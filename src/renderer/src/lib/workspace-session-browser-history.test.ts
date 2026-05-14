import { describe, expect, it } from 'vitest'
import type { BrowserHistoryEntry } from '../../../shared/types'
import { MAX_BROWSER_HISTORY_ENTRIES } from '../../../shared/workspace-session-browser-history'
import { buildWorkspaceSessionPayload, type WorkspaceSessionSnapshot } from './workspace-session'

function createSnapshot(browserUrlHistory: BrowserHistoryEntry[]): WorkspaceSessionSnapshot {
  return {
    activeRepoId: null,
    activeWorktreeId: null,
    activeTabId: null,
    tabsByWorktree: {},
    terminalLayoutsByTabId: {},
    activeTabIdByWorktree: {},
    openFiles: [],
    activeFileIdByWorktree: {},
    activeTabTypeByWorktree: {},
    browserTabsByWorktree: {},
    browserPagesByWorkspace: {},
    activeBrowserTabIdByWorktree: {},
    browserUrlHistory,
    unifiedTabsByWorktree: {},
    groupsByWorktree: {},
    layoutByWorktree: {},
    activeGroupIdByWorktree: {},
    sshConnectionStates: new Map(),
    repos: [],
    worktreesByRepo: {},
    lastKnownRelayPtyIdByTabId: {},
    lastVisitedAtByWorktreeId: {}
  }
}

describe('workspace session browser history payloads', () => {
  it('caps history and reduces serialized bytes at the payload boundary', () => {
    const oversizedHistory = Array.from({ length: 500 }, (_, index) => ({
      url: `https://example.com/${index}`,
      normalizedUrl: `https://example.com/${index}`,
      title: `${'Search result '.repeat(40)}${index}`,
      lastVisitedAt: 1_700_000_000_000 - index,
      visitCount: 1
    }))
    const uncappedPayload = {
      ...buildWorkspaceSessionPayload(createSnapshot([])),
      browserUrlHistory: oversizedHistory
    }
    const payload = buildWorkspaceSessionPayload(createSnapshot(oversizedHistory))

    expect(payload.browserUrlHistory).toHaveLength(MAX_BROWSER_HISTORY_ENTRIES)
    expect(payload.browserUrlHistory?.at(-1)?.url).toBe('https://example.com/199')
    expect(Buffer.byteLength(JSON.stringify(payload))).toBeLessThan(
      Buffer.byteLength(JSON.stringify(uncappedPayload)) / 2
    )
  })
})
