import { describe, expect, it } from 'vitest'
import {
  getResourceUsageAllWorktrees,
  getResourceUsageRepos,
  getResourceUsageRuntimePaneTitlesByTabId,
  getResourceUsageTabsByWorktree
} from './resource-usage-open-slices'
import type { AppState } from '../../store'

const terminalTab = (id: string): AppState['tabsByWorktree'][string][number] => ({
  id,
  ptyId: null,
  worktreeId: 'wt-1',
  title: id,
  customTitle: null,
  color: null,
  sortOrder: 0,
  createdAt: 0
})

const worktree = (): AppState['worktreesByRepo'][string][number] => ({
  id: 'wt-1',
  repoId: 'repo-1',
  path: '/repo/wt-1',
  displayName: 'wt-1',
  comment: '',
  branch: 'main',
  head: 'abc123',
  isBare: false,
  isMainWorktree: false,
  linkedIssue: null,
  linkedPR: null,
  linkedLinearIssue: null,
  isArchived: false,
  isUnread: false,
  isPinned: false,
  sortOrder: 0,
  lastActivityAt: 0
})

describe('resource usage open slices', () => {
  it('returns stable empty slices while the popover is closed', () => {
    const tabsByWorktree = { 'wt-1': [terminalTab('tab-1')] }
    const runtimePaneTitlesByTabId = {
      'tab-1': { 'tab-1:0': 'Working' }
    } as AppState['runtimePaneTitlesByTabId']

    const closedTabs = getResourceUsageTabsByWorktree({ tabsByWorktree }, false)
    const closedTitles = getResourceUsageRuntimePaneTitlesByTabId(
      { runtimePaneTitlesByTabId },
      false
    )

    expect(closedTabs).toBe(getResourceUsageTabsByWorktree({ tabsByWorktree: {} }, false))
    expect(closedTitles).toBe(
      getResourceUsageRuntimePaneTitlesByTabId({ runtimePaneTitlesByTabId: {} }, false)
    )
    expect(closedTabs).toEqual({})
    expect(closedTitles).toEqual({})
  })

  it('returns live slices while the popover is open', () => {
    const tabsByWorktree = { 'wt-1': [terminalTab('tab-1')] }
    const runtimePaneTitlesByTabId = {
      'tab-1': { 'tab-1:0': 'Working' }
    } as AppState['runtimePaneTitlesByTabId']

    expect(getResourceUsageTabsByWorktree({ tabsByWorktree }, true)).toBe(tabsByWorktree)
    expect(getResourceUsageRuntimePaneTitlesByTabId({ runtimePaneTitlesByTabId }, true)).toBe(
      runtimePaneTitlesByTabId
    )
  })

  it('gates repo and worktree slices while closed or runtime-backed', () => {
    const repos = [{ id: 'repo-1', path: '/repo', kind: 'git' }] as AppState['repos']
    const row = worktree()
    const worktreesByRepo = {
      'repo-1': [row]
    }

    expect(getResourceUsageRepos({ repos }, false, false)).toBe(
      getResourceUsageRepos({ repos: [] }, false, false)
    )
    expect(getResourceUsageAllWorktrees({ worktreesByRepo }, false, false)).toBe(
      getResourceUsageAllWorktrees({ worktreesByRepo: {} }, false, false)
    )
    expect(getResourceUsageRepos({ repos }, true, true)).toEqual([])
    expect(getResourceUsageAllWorktrees({ worktreesByRepo }, true, true)).toEqual([])
    expect(getResourceUsageRepos({ repos }, true, false)).toBe(repos)
    expect(getResourceUsageAllWorktrees({ worktreesByRepo }, true, false)).toEqual([row])
  })
})
