import { describe, expect, it } from 'vitest'
import {
  getResourceUsageAllWorktrees,
  getResourceUsagePtyIdsByTabId,
  getResourceUsageRepos,
  getResourceUsageRuntimePaneTitlesByTabId,
  getResourceUsageTerminalLayoutsByTabId,
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
    const ptyIdsByTabId = { 'tab-1': ['pty-1'] }
    const terminalLayoutsByTabId = {
      'tab-1': {
        root: { type: 'leaf' as const, leafId: 'leaf-1' },
        activeLeafId: 'leaf-1',
        expandedLeafId: null
      }
    }
    const runtimePaneTitlesByTabId = {
      'tab-1': { 'tab-1:0': 'Working' }
    } as AppState['runtimePaneTitlesByTabId']

    const closedTabs = getResourceUsageTabsByWorktree({ tabsByWorktree }, false)
    const closedPtyIds = getResourceUsagePtyIdsByTabId({ ptyIdsByTabId }, false)
    const closedLayouts = getResourceUsageTerminalLayoutsByTabId({ terminalLayoutsByTabId }, false)
    const closedTitles = getResourceUsageRuntimePaneTitlesByTabId(
      { runtimePaneTitlesByTabId },
      false
    )

    expect(closedTabs).toBe(getResourceUsageTabsByWorktree({ tabsByWorktree: {} }, false))
    expect(closedTitles).toBe(
      getResourceUsageRuntimePaneTitlesByTabId({ runtimePaneTitlesByTabId: {} }, false)
    )
    expect(closedPtyIds).toBe(getResourceUsagePtyIdsByTabId({ ptyIdsByTabId: {} }, false))
    expect(closedLayouts).toBe(
      getResourceUsageTerminalLayoutsByTabId({ terminalLayoutsByTabId: {} }, false)
    )
    expect(closedTabs).toEqual({})
    expect(closedPtyIds).toEqual({})
    expect(closedLayouts).toEqual({})
    expect(closedTitles).toEqual({})
  })

  it('returns live slices while the popover is open', () => {
    const tabsByWorktree = { 'wt-1': [terminalTab('tab-1')] }
    const ptyIdsByTabId = { 'tab-1': ['pty-1'] }
    const terminalLayoutsByTabId = {
      'tab-1': {
        root: { type: 'leaf' as const, leafId: 'leaf-1' },
        activeLeafId: 'leaf-1',
        expandedLeafId: null
      }
    }
    const runtimePaneTitlesByTabId = {
      'tab-1': { 'tab-1:0': 'Working' }
    } as AppState['runtimePaneTitlesByTabId']

    expect(getResourceUsageTabsByWorktree({ tabsByWorktree }, true)).toBe(tabsByWorktree)
    expect(getResourceUsagePtyIdsByTabId({ ptyIdsByTabId }, true)).toBe(ptyIdsByTabId)
    expect(getResourceUsageTerminalLayoutsByTabId({ terminalLayoutsByTabId }, true)).toBe(
      terminalLayoutsByTabId
    )
    expect(getResourceUsageRuntimePaneTitlesByTabId({ runtimePaneTitlesByTabId }, true)).toBe(
      runtimePaneTitlesByTabId
    )
  })

  it('gates repo and worktree slices only while closed', () => {
    const repos = [{ id: 'repo-1', path: '/repo', kind: 'git' }] as AppState['repos']
    const row = worktree()
    const worktreesByRepo = {
      'repo-1': [row]
    }

    expect(getResourceUsageRepos({ repos }, false)).toBe(
      getResourceUsageRepos({ repos: [] }, false)
    )
    expect(getResourceUsageAllWorktrees({ worktreesByRepo }, false)).toBe(
      getResourceUsageAllWorktrees({ worktreesByRepo: {} }, false)
    )
    expect(getResourceUsageRepos({ repos }, true)).toBe(repos)
    expect(getResourceUsageAllWorktrees({ worktreesByRepo }, true)).toEqual([row])
  })
})
