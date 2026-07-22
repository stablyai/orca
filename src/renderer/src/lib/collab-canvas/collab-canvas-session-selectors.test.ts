/**
 * Regression: panel boards (sessionWorktreeId === null) must not return a
 * fresh [] from Zustand getSnapshot — that triggers React #185 via
 * useSyncExternalStore forceStoreRerender (dogfood crash on User Panel boards).
 */
import { describe, expect, it } from 'vitest'
import {
  EMPTY_GROUPS,
  EMPTY_UNIFIED_TABS,
  selectGroupsForSession,
  selectUnifiedTabsForSession
} from './collab-canvas-session-selectors'

describe('CollabCanvas panel store selectors (React #185)', () => {
  it('returns the same EMPTY_UNIFIED_TABS identity for every panel-path call', () => {
    const a = selectUnifiedTabsForSession(undefined, null)
    const b = selectUnifiedTabsForSession({}, null)
    const c = selectUnifiedTabsForSession({ 'wt-x': [{ id: 't1', contentType: 'terminal' }] }, null)
    expect(a).toBe(EMPTY_UNIFIED_TABS)
    expect(b).toBe(EMPTY_UNIFIED_TABS)
    expect(c).toBe(EMPTY_UNIFIED_TABS)
    expect(a).toBe(b)
    expect(b).toBe(c)
  })

  it('returns the same EMPTY_GROUPS identity for every panel-path call', () => {
    const a = selectGroupsForSession(undefined, null)
    const b = selectGroupsForSession({ 'wt-x': [] }, null)
    expect(a).toBe(EMPTY_GROUPS)
    expect(b).toBe(EMPTY_GROUPS)
    expect(a).toBe(b)
  })

  it('returns the live worktree array for session path (stable when present)', () => {
    const tabs = [{ id: 't1', contentType: 'terminal' }]
    const map = { 'repo::/w': tabs }
    expect(selectUnifiedTabsForSession(map, 'repo::/w')).toBe(tabs)
  })

  it('uses EMPTY when worktree key is missing on session path', () => {
    expect(selectUnifiedTabsForSession({}, 'missing')).toBe(EMPTY_UNIFIED_TABS)
    expect(selectGroupsForSession({}, 'missing')).toBe(EMPTY_GROUPS)
  })
})
