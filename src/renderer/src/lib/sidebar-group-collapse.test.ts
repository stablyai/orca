import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { useAppStore } from '@/store'
import {
  registerSidebarGroupCollapseScope,
  toggleSidebarGroupsCollapse
} from './sidebar-group-collapse'

let unregister: (() => void) | undefined

beforeEach(() => {
  vi.stubGlobal('window', { api: { ui: { set: vi.fn().mockResolvedValue(undefined) } } })
  useAppStore.setState({
    collapsedGroups: new Set(['repo:b', 'repo:filtered', 'lineage:parent', 'agent:worker']),
    activeWorktreeId: 'repo:a::/active'
  })
})

afterEach(() => {
  unregister?.()
  vi.unstubAllGlobals()
})

describe('sidebar group collapse action', () => {
  it('collapses a mixed scope including hidden nested headers, then expands it without touching other disclosures', () => {
    unregister = registerSidebarGroupCollapseScope([
      'project-group:parent',
      'project-group:nested',
      'repo:a',
      'repo:b',
      'host:ssh:box',
      'pinned'
    ])

    expect(toggleSidebarGroupsCollapse()).toBe(true)
    expect([...useAppStore.getState().collapsedGroups]).toEqual([
      'repo:b',
      'repo:filtered',
      'lineage:parent',
      'agent:worker',
      'project-group:parent',
      'project-group:nested',
      'repo:a',
      'host:ssh:box',
      'pinned'
    ])
    expect(useAppStore.getState().activeWorktreeId).toBe('repo:a::/active')

    expect(toggleSidebarGroupsCollapse()).toBe(true)
    expect([...useAppStore.getState().collapsedGroups]).toEqual([
      'repo:filtered',
      'lineage:parent',
      'agent:worker'
    ])
    expect(useAppStore.getState().activeWorktreeId).toBe('repo:a::/active')
  })

  it('leaves the current presentation unchanged for an empty scope', () => {
    unregister = registerSidebarGroupCollapseScope([])
    expect(toggleSidebarGroupsCollapse()).toBe(false)
    expect([...useAppStore.getState().collapsedGroups]).toEqual([
      'repo:b',
      'repo:filtered',
      'lineage:parent',
      'agent:worker'
    ])
  })
})
