import { describe, it, expect } from 'vitest'
import type { Tab, TabGroup } from '../../../../shared/tab-types'
import { pickTabCloseLanding } from './tab-close-landing'

function makeTab(overrides: Partial<Tab> & { id: string }): Tab {
  return {
    entityId: overrides.id,
    groupId: 'g1',
    worktreeId: 'w1',
    contentType: 'terminal',
    label: overrides.id,
    customLabel: null,
    color: null,
    sortOrder: 0,
    createdAt: 0,
    ...overrides
  }
}

const terminalA = makeTab({ id: 'a' })
const terminalB = makeTab({ id: 'b' })
const terminalC = makeTab({ id: 'c' })
const browserD = makeTab({ id: 'd', contentType: 'browser', entityId: 'ws-d' })

const group: TabGroup = {
  id: 'g1',
  worktreeId: 'w1',
  activeTabId: 'd',
  tabOrder: ['a', 'b', 'c', 'd'],
  recentTabIds: ['a', 'b', 'c', 'd']
}

function makeState(overrides?: {
  group?: TabGroup
  tabs?: Tab[]
  terminalRows?: { id: string }[]
  browserRows?: { id: string }[]
  openFiles?: { id: string }[]
}) {
  return {
    unifiedTabsByWorktree: { w1: overrides?.tabs ?? [terminalA, terminalB, terminalC, browserD] },
    groupsByWorktree: { w1: [overrides?.group ?? group] },
    tabsByWorktree: { w1: overrides?.terminalRows ?? [{ id: 'a' }, { id: 'b' }, { id: 'c' }] },
    browserTabsByWorktree: { w1: overrides?.browserRows ?? [{ id: 'ws-d' }] },
    openFiles: overrides?.openFiles ?? []
  }
}

describe('pickTabCloseLanding', () => {
  it('returns the tab used before the closing one, not the first tab', () => {
    const landing = pickTabCloseLanding(makeState(), 'w1', {
      contentType: 'browser',
      entityId: 'ws-d'
    })
    expect(landing?.id).toBe('c')
  })

  it('crosses kinds: the last terminal lands on the browser tab used before it', () => {
    const state = makeState({
      tabs: [terminalC, browserD],
      group: {
        ...group,
        activeTabId: 'c',
        tabOrder: ['d', 'c'],
        recentTabIds: ['d', 'c']
      },
      terminalRows: [{ id: 'c' }]
    })
    const landing = pickTabCloseLanding(state, 'w1', {
      contentType: 'terminal',
      entityId: 'c'
    })
    expect(landing?.id).toBe('d')
  })

  it('skips the closing tab wherever it sits in the MRU stack', () => {
    const state = makeState({
      group: { ...group, activeTabId: 'd', recentTabIds: ['a', 'd', 'c', 'd'] }
    })
    const landing = pickTabCloseLanding(state, 'w1', {
      contentType: 'browser',
      entityId: 'ws-d'
    })
    expect(landing?.id).toBe('c')
  })

  it('skips a landing tab whose backing entity is already gone', () => {
    const state = makeState({ terminalRows: [{ id: 'a' }, { id: 'b' }] })
    const landing = pickTabCloseLanding(state, 'w1', {
      contentType: 'browser',
      entityId: 'ws-d'
    })
    expect(landing?.id).toBe('b')
  })

  it('stays inside the closing tab group', () => {
    const state = makeState({
      tabs: [makeTab({ id: 'a', groupId: 'g2' }), browserD],
      group: { ...group, tabOrder: ['d'], recentTabIds: ['d'] }
    })
    const landing = pickTabCloseLanding(state, 'w1', {
      contentType: 'browser',
      entityId: 'ws-d'
    })
    expect(landing).toBeNull()
  })

  it('returns null when the group has no other visited tab, so the caller falls back', () => {
    const state = makeState({
      tabs: [browserD],
      group: { ...group, tabOrder: ['d'], recentTabIds: ['d'] },
      terminalRows: []
    })
    const landing = pickTabCloseLanding(state, 'w1', {
      contentType: 'browser',
      entityId: 'ws-d'
    })
    expect(landing).toBeNull()
  })
})
