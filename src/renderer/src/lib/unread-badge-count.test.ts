import { describe, expect, it } from 'vitest'
import type { TerminalTab } from '../../../shared/terminal-tab-types'
import type { Worktree } from '../../../shared/worktree/types'
import { getUnreadBadgeCount } from './unread-badge-count'
import { getWorktreeHostIdentity } from '../../../shared/worktree/host-qualified-identity'
import type { UnreadBadgeCountSources } from './unread-badge-count'

function worktree(id: string, isUnread: boolean): Worktree {
  return { id, isUnread } as Worktree
}

function tab(id: string): TerminalTab {
  return { id } as TerminalTab
}

function hiddenChildSources(): UnreadBadgeCountSources {
  const child = { id: 'same-id', hostId: 'local', isUnread: false } as const
  return {
    worktreesByRepo: { repo: [child] },
    tabsByWorktree: { 'same-id': [{ id: 'tab-1' }] },
    unreadTerminalTabs: { 'tab-1': true },
    hiddenChildUnreadIdentities: new Set([getWorktreeHostIdentity(child)])
  }
}

describe('getUnreadBadgeCount', () => {
  it('counts unread tabs until their execution-host ownership is known', () => {
    expect(getUnreadBadgeCount(hiddenChildSources())).toBe(1)
  })
  it.each(['ssh:remote', 'runtime:remote'] as const)(
    'counts %s tab unread before its same-id worktree row hydrates',
    (executionHostId) => {
      const sources = hiddenChildSources()
      sources.unifiedTabsByWorktree = {
        'same-id': [{ id: 'tab-1', worktreeId: 'same-id', executionHostId }]
      }
      expect(getUnreadBadgeCount(sources)).toBe(1)
    }
  )

  it('suppresses tab unread only with explicit hidden-child ownership', () => {
    const sources = hiddenChildSources()
    sources.unifiedTabsByWorktree = {
      'same-id': [{ id: 'tab-1', worktreeId: 'same-id', executionHostId: 'local' }]
    }
    expect(getUnreadBadgeCount(sources)).toBe(0)
    sources.worktreesByRepo = {
      repo: [
        ...sources.worktreesByRepo.repo,
        { id: 'same-id', hostId: 'ssh:remote', isUnread: false }
      ]
    }
    expect(getUnreadBadgeCount(sources)).toBe(0)
  })

  it('counts tab unread with missing, mismatched or duplicate host ownership', () => {
    const sources = hiddenChildSources()
    for (const owners of [
      [{ id: 'tab-1', worktreeId: 'same-id' }],
      [{ id: 'tab-1', worktreeId: 'other-id', executionHostId: 'local' } as const],
      [
        { id: 'tab-1', worktreeId: 'same-id', executionHostId: 'local' } as const,
        { id: 'tab-1', worktreeId: 'same-id', executionHostId: 'ssh:remote' } as const
      ]
    ]) {
      expect(
        getUnreadBadgeCount({ ...sources, unifiedTabsByWorktree: { 'same-id': owners } })
      ).toBe(1)
    }
  })

  it.each([true, false])(
    'keeps a shared unread tab ID visible regardless of child-first order (%s)',
    (childFirst) => {
      const sources = hiddenChildSources()
      sources.unifiedTabsByWorktree = {
        'same-id': [{ id: 'tab-1', worktreeId: 'same-id', executionHostId: 'local' }],
        visible: [{ id: 'tab-1', worktreeId: 'visible', executionHostId: 'ssh:remote' }]
      }
      const visibleTabs = [{ id: 'tab-1' }]
      sources.tabsByWorktree = childFirst
        ? { ...sources.tabsByWorktree, visible: visibleTabs }
        : { visible: visibleTabs, ...sources.tabsByWorktree }
      expect(getUnreadBadgeCount(sources)).toBe(1)
    }
  )

  it('counts unmatched unread entries during hydration', () => {
    const sources = hiddenChildSources()
    sources.tabsByWorktree = {}
    expect(getUnreadBadgeCount(sources)).toBe(1)
  })

  it('counts unread worktrees', () => {
    expect(
      getUnreadBadgeCount({
        worktreesByRepo: { repo: [worktree('wt-1', true), worktree('wt-2', false)] },
        tabsByWorktree: {},
        unreadTerminalTabs: {}
      })
    ).toBe(1)
  })

  it('dedupes unread terminal tabs against their worktree', () => {
    expect(
      getUnreadBadgeCount({
        worktreesByRepo: { repo: [worktree('wt-1', true)] },
        tabsByWorktree: { 'wt-1': [tab('tab-1'), tab('tab-2')] },
        unreadTerminalTabs: { 'tab-1': true, 'tab-2': true }
      })
    ).toBe(1)
  })

  it('counts tab-only unread activity by owning worktree', () => {
    expect(
      getUnreadBadgeCount({
        worktreesByRepo: { repo: [worktree('wt-1', false), worktree('wt-2', false)] },
        tabsByWorktree: { 'wt-1': [tab('tab-1')], 'wt-2': [tab('tab-2')] },
        unreadTerminalTabs: { 'tab-1': true, 'tab-2': true }
      })
    ).toBe(2)
  })
})
