// @vitest-environment happy-dom
import { act, renderHook } from '@testing-library/react'
import { afterEach, describe, expect, it } from 'vitest'
import type { RuntimeMobileSessionTabsResult } from '../../../shared/runtime-types'
import { toWebTerminalSurfaceTabId } from '../../../shared/terminal-surface-id'
import {
  clearWebSessionTerminalParkAuthorityForEnvironment,
  clearWebSessionTerminalParkAuthorityForWorktree,
  getWebSessionTerminalParkAuthorityCountForTests,
  getWebSessionTerminalParkAuthorityRevisionKey,
  getWebSessionTerminalParkAuthorityTrackingCountsForTests,
  hasWebSessionTerminalParkAuthority,
  replaceWebSessionTerminalParkAuthority,
  resetWebSessionTerminalParkAuthorityForTests,
  useWebSessionTerminalParkAuthorityRevisionKey
} from './web-session-terminal-park-authority'
import {
  resetWebSessionTabsSnapshotFreshnessForTests,
  shouldApplyWebSessionTabsSnapshot
} from './web-session-tabs-sync'

const LEAF_ID = '11111111-1111-4111-8111-111111111111'
const WORKTREE_ID = 'repo::/worktree'
const TAB_ID = toWebTerminalSurfaceTabId('host-tab')

function snapshot(
  args: {
    epoch?: string
    version?: number
    terminal?: string
    status?: 'ready' | 'pending-handle'
  } = {}
): RuntimeMobileSessionTabsResult {
  const status = args.status ?? 'ready'
  const terminalState =
    status === 'ready'
      ? ({ status: 'ready', terminal: args.terminal ?? 'pty-1' } as const)
      : ({ status: 'pending-handle', terminal: null } as const)
  return {
    worktree: WORKTREE_ID,
    publicationEpoch: args.epoch ?? 'epoch-1',
    snapshotVersion: args.version ?? 1,
    activeGroupId: null,
    activeTabId: 'host-pane',
    activeTabType: 'terminal',
    tabs: [
      {
        type: 'terminal',
        id: 'host-pane',
        parentTabId: 'host-tab',
        leafId: LEAF_ID,
        title: 'Terminal',
        isActive: true,
        ...terminalState
      }
    ]
  }
}

function has(environmentId: string, terminal: string): boolean {
  return hasWebSessionTerminalParkAuthority({
    environmentId,
    worktreeId: WORKTREE_ID,
    tabId: TAB_ID,
    leafId: LEAF_ID,
    ptyId: `remote:${environmentId}@@${terminal}`
  })
}

describe('web session terminal park authority', () => {
  afterEach(() => {
    resetWebSessionTabsSnapshotFreshnessForTests()
    resetWebSessionTerminalParkAuthorityForTests()
  })

  it('keeps exact same-shaped identities isolated across paired clients', () => {
    replaceWebSessionTerminalParkAuthority(snapshot(), 'env-a')
    replaceWebSessionTerminalParkAuthority(snapshot(), 'env-b')
    expect(has('env-a', 'pty-1')).toBe(true)
    expect(has('env-b', 'pty-1')).toBe(true)
    expect(getWebSessionTerminalParkAuthorityCountForTests()).toBe(2)
  })

  it('revokes the prior PTY across remint and host recreation', () => {
    replaceWebSessionTerminalParkAuthority(snapshot(), 'env-a')
    replaceWebSessionTerminalParkAuthority(
      snapshot({ epoch: 'epoch-2', terminal: 'pty-2' }),
      'env-a'
    )
    expect(has('env-a', 'pty-1')).toBe(false)
    expect(has('env-a', 'pty-2')).toBe(true)
  })

  it('updates only from accepted subscription order', () => {
    expect(
      shouldApplyWebSessionTabsSnapshot(snapshot({ version: 2, terminal: 'pty-2' }), 'env-a')
    ).toBe(true)
    expect(shouldApplyWebSessionTabsSnapshot(snapshot({ terminal: 'pty-stale' }), 'env-a')).toBe(
      false
    )
    expect(has('env-a', 'pty-2')).toBe(true)
    expect(has('env-a', 'pty-stale')).toBe(false)
  })

  it('grants nothing for a legacy pending-handle snapshot', () => {
    replaceWebSessionTerminalParkAuthority(snapshot({ status: 'pending-handle' }), 'env-a')
    expect(getWebSessionTerminalParkAuthorityCountForTests()).toBe(0)
  })

  it('clears one disconnected client without disturbing another', () => {
    replaceWebSessionTerminalParkAuthority(snapshot(), 'env-a')
    replaceWebSessionTerminalParkAuthority(snapshot(), 'env-b')
    clearWebSessionTerminalParkAuthorityForEnvironment('env-a')
    expect(has('env-a', 'pty-1')).toBe(false)
    expect(has('env-b', 'pty-1')).toBe(true)
  })

  it('publishes only matching session authority loss and recovery', () => {
    const { result, unmount } = renderHook(() =>
      useWebSessionTerminalParkAuthorityRevisionKey(WORKTREE_ID, 'env-a')
    )
    const emptyRevision = result.current
    act(() => replaceWebSessionTerminalParkAuthority(snapshot(), 'env-b'))
    expect(result.current).toBe(emptyRevision)
    expect(getWebSessionTerminalParkAuthorityTrackingCountsForTests().revisions).toBe(0)

    act(() => replaceWebSessionTerminalParkAuthority(snapshot(), 'env-a'))
    const exactRevision = result.current
    expect(exactRevision).not.toBe(emptyRevision)
    act(() => clearWebSessionTerminalParkAuthorityForEnvironment('env-a'))
    expect(result.current).not.toBe(exactRevision)
    const revokedRevision = result.current
    act(() => replaceWebSessionTerminalParkAuthority(snapshot(), 'env-a'))
    expect(result.current).not.toBe(revokedRevision)
    unmount()
  })

  it('drops cleared session revisions back to zero', () => {
    const { unmount } = renderHook(() =>
      useWebSessionTerminalParkAuthorityRevisionKey(WORKTREE_ID, 'env-a')
    )
    act(() => replaceWebSessionTerminalParkAuthority(snapshot(), 'env-a'))
    expect(getWebSessionTerminalParkAuthorityRevisionKey(WORKTREE_ID, ['env-a'])).not.toBe(
      'env-a:0'
    )

    act(() => clearWebSessionTerminalParkAuthorityForEnvironment('env-a'))
    expect(getWebSessionTerminalParkAuthorityRevisionKey(WORKTREE_ID, ['env-a'])).toBe('env-a:0')
    unmount()
  })

  it('bounds authority tracking through every cleanup boundary', () => {
    const { unmount } = renderHook(() =>
      useWebSessionTerminalParkAuthorityRevisionKey(WORKTREE_ID, 'env-a')
    )
    expect(getWebSessionTerminalParkAuthorityTrackingCountsForTests()).toEqual({
      authorities: 0,
      sessions: 0,
      revisions: 0,
      listeners: 1,
      listenerWorktrees: 1
    })

    act(() => replaceWebSessionTerminalParkAuthority(snapshot(), 'env-a'))
    expect(getWebSessionTerminalParkAuthorityTrackingCountsForTests()).toEqual({
      authorities: 1,
      sessions: 1,
      revisions: 1,
      listeners: 1,
      listenerWorktrees: 1
    })

    act(() =>
      replaceWebSessionTerminalParkAuthority(
        snapshot({ status: 'pending-handle', version: 2 }),
        'env-a'
      )
    )
    expect(getWebSessionTerminalParkAuthorityTrackingCountsForTests()).toEqual({
      authorities: 0,
      sessions: 0,
      revisions: 0,
      listeners: 1,
      listenerWorktrees: 1
    })

    act(() => replaceWebSessionTerminalParkAuthority(snapshot({ version: 3 }), 'env-a'))
    act(() => clearWebSessionTerminalParkAuthorityForWorktree('env-a', WORKTREE_ID))
    expect(getWebSessionTerminalParkAuthorityTrackingCountsForTests().revisions).toBe(0)

    act(() => replaceWebSessionTerminalParkAuthority(snapshot({ version: 4 }), 'env-a'))
    act(() => clearWebSessionTerminalParkAuthorityForEnvironment('env-a'))
    expect(getWebSessionTerminalParkAuthorityTrackingCountsForTests().revisions).toBe(0)

    act(() => replaceWebSessionTerminalParkAuthority(snapshot({ version: 5 }), 'env-a'))
    unmount()
    expect(getWebSessionTerminalParkAuthorityTrackingCountsForTests()).toEqual({
      authorities: 1,
      sessions: 1,
      revisions: 0,
      listeners: 0,
      listenerWorktrees: 0
    })
    clearWebSessionTerminalParkAuthorityForEnvironment('env-a')
    expect(getWebSessionTerminalParkAuthorityTrackingCountsForTests().sessions).toBe(0)
  })
})
