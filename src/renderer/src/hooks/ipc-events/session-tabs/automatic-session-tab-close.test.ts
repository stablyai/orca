import { describe, expect, it } from 'vitest'
import type { Tab, TabGroup } from '../../../../../shared/workspace-layout/tab-groups/tab-types'
import { automaticSessionTabCloseKept } from './automatic-session-tab-close'

const SINCE = 1_000_000
const WT = 'bot-home'

function tab(id: string, overrides: Partial<Tab> = {}): Tab {
  return {
    id,
    entityId: `entity-${id}`,
    groupId: 'g1',
    worktreeId: WT,
    contentType: 'agent-session',
    label: id,
    customLabel: null,
    color: null,
    sortOrder: 0,
    createdAt: SINCE - 10,
    ...overrides
  }
}

function state(tabs: Tab[], activeTabId: string | null) {
  const group: TabGroup = {
    id: 'g1',
    worktreeId: WT,
    activeTabId,
    tabOrder: tabs.map((entry) => entry.id)
  }
  return { unifiedTabsByWorktree: { [WT]: tabs }, groupsByWorktree: { [WT]: [group] } }
}

const kept = (tabs: Tab[], activeTabId: string | null, id: string) =>
  automaticSessionTabCloseKept(state(tabs, activeTabId), WT, id, { keptIfTouchedSince: SINCE })

describe('automaticSessionTabCloseKept', () => {
  it('lets an untouched tab behind another go', () => {
    expect(kept([tab('front'), tab('old')], 'front', 'old')).toBe(false)
  })

  it('keeps the tab in front, a pinned one, and one focused or opened since', () => {
    expect(kept([tab('a')], 'a', 'a')).toBe(true)
    expect(kept([tab('front'), tab('a', { isPinned: true })], 'front', 'a')).toBe(true)
    expect(kept([tab('front'), tab('a', { lastFocusedAt: SINCE })], 'front', 'a')).toBe(true)
    expect(kept([tab('front'), tab('a', { createdAt: SINCE + 1 })], 'front', 'a')).toBe(true)
  })

  it('finds the tab by its entity too, and keeps nothing it does not have', () => {
    expect(kept([tab('front'), tab('a', { isPinned: true })], 'front', 'entity-a')).toBe(true)
    expect(kept([tab('front')], 'front', 'missing')).toBe(false)
  })
})
