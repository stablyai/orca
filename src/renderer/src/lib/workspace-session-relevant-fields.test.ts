import { describe, expect, it } from 'vitest'
import { SESSION_RELEVANT_FIELDS, type WorkspaceSessionSnapshot } from './workspace-session'

describe('SESSION_RELEVANT_FIELDS', () => {
  // Why: this list gates the App-level session-write debounce subscriber.
  // A snapshot field omitted here would persist stale data after that field changes.
  const fixture: Record<keyof WorkspaceSessionSnapshot, true> = {
    activeRepoId: true,
    activeWorktreeId: true,
    activeTabId: true,
    tabsByWorktree: true,
    terminalLayoutsByTabId: true,
    activeTabIdByWorktree: true,
    openFiles: true,
    activeFileIdByWorktree: true,
    activeTabTypeByWorktree: true,
    browserTabsByWorktree: true,
    browserPagesByWorkspace: true,
    activeBrowserTabIdByWorktree: true,
    browserUrlHistory: true,
    unifiedTabsByWorktree: true,
    groupsByWorktree: true,
    layoutByWorktree: true,
    activeGroupIdByWorktree: true,
    sshConnectionStates: true,
    repos: true,
    worktreesByRepo: true,
    lastKnownRelayPtyIdByTabId: true,
    lastVisitedAtByWorktreeId: true
  }

  it('contains every key of WorkspaceSessionSnapshot', () => {
    const fixtureKeys = Object.keys(fixture)
    expect(
      fixtureKeys.every((k) => (SESSION_RELEVANT_FIELDS as readonly string[]).includes(k))
    ).toBe(true)
    expect(SESSION_RELEVANT_FIELDS.length).toBe(fixtureKeys.length)
  })

  it('has no duplicate entries', () => {
    expect(new Set(SESSION_RELEVANT_FIELDS).size).toBe(SESSION_RELEVANT_FIELDS.length)
  })
})
