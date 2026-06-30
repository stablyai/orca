import { describe, expect, it } from 'vitest'
import type { TerminalTab, Worktree } from '../../../shared/types'
import { getUnreadBadgeCount, getUnreadBadgeModel } from './unread-badge-count'

function worktree(id: string, isUnread: boolean): Worktree {
  return { id, isUnread } as Worktree
}

function tab(id: string): TerminalTab {
  return { id } as TerminalTab
}

describe('getUnreadBadgeCount', () => {
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

  it('groups unread badge contributors by worktree', () => {
    expect(
      getUnreadBadgeModel({
        worktreesByRepo: {
          repo: [
            { ...worktree('wt-1', true), displayName: 'Feature A', repoId: 'repo' },
            { ...worktree('wt-2', false), displayName: 'Feature B', repoId: 'repo' }
          ]
        },
        tabsByWorktree: {
          'wt-1': [{ ...tab('tab-1'), title: 'Terminal 1' }],
          'wt-2': [{ ...tab('tab-2'), title: 'Tests' }]
        },
        unreadTerminalTabs: { 'tab-1': true, 'tab-2': true }
      })
    ).toEqual({
      count: 2,
      contributors: [
        {
          id: 'wt-1',
          repoLabel: 'repo',
          worktreeId: 'wt-1',
          worktreeLabel: 'Feature A',
          unreadWorktree: true,
          unreadTabIds: ['tab-1'],
          unreadTabTitles: ['Terminal 1']
        },
        {
          id: 'wt-2',
          repoLabel: 'repo',
          worktreeId: 'wt-2',
          worktreeLabel: 'Feature B',
          unreadWorktree: false,
          unreadTabIds: ['tab-2'],
          unreadTabTitles: ['Tests']
        }
      ]
    })
  })

  it('keeps detached unread tabs as separate contributors', () => {
    expect(
      getUnreadBadgeModel({
        worktreesByRepo: { repo: [worktree('wt-1', false)] },
        tabsByWorktree: {},
        unreadTerminalTabs: { 'tab-1': true, 'tab-2': true }
      })
    ).toEqual({
      count: 2,
      contributors: [
        {
          id: 'detached:tab-1',
          repoLabel: null,
          worktreeId: null,
          worktreeLabel: 'Detached terminal tab',
          unreadWorktree: false,
          unreadTabIds: ['tab-1'],
          unreadTabTitles: ['tab-1']
        },
        {
          id: 'detached:tab-2',
          repoLabel: null,
          worktreeId: null,
          worktreeLabel: 'Detached terminal tab',
          unreadWorktree: false,
          unreadTabIds: ['tab-2'],
          unreadTabTitles: ['tab-2']
        }
      ]
    })
  })
})
