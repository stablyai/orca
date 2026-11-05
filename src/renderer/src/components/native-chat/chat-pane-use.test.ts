import { afterEach, describe, expect, it } from 'vitest'
import { useAppStore } from '@/store'
import type { Tab } from '../../../../shared/tab-types'
import {
  clearPaneUseForTests,
  isWatchingTabsForTests,
  paneUseRecordCountForTests,
  readPaneUse,
  recordPaneUse
} from './chat-pane-use'

afterEach(() => {
  clearPaneUseForTests()
  useAppStore.setState({ unifiedTabsByWorktree: {} })
})

function liveTab(entityId: string, worktreeId = 'wt', id = entityId): Tab {
  return {
    id,
    entityId,
    groupId: 'g',
    worktreeId,
    contentType: 'terminal',
    label: entityId,
    customLabel: null,
    color: null,
    sortOrder: 0,
    createdAt: 0
  }
}

function tabs(worktreeId: string, prefix: string, count: number): Tab[] {
  return Array.from({ length: count }, (_, index) => liveTab(`${prefix}-${index}`, worktreeId))
}

function setTabs(unifiedTabsByWorktree: Record<string, Tab[]>): void {
  useAppStore.setState({ unifiedTabsByWorktree })
}

let tabVisits = 0
/** Tabs that count how often anything reads which entity they hold. */
function counted(list: Tab[]): Tab[] {
  return list.map((tab) => {
    const { entityId, ...rest } = tab
    return Object.defineProperty({ ...rest, entityId: '' }, 'entityId', {
      get: () => {
        tabVisits++
        return entityId
      }
    })
  })
}

describe('chat pane use', () => {
  // Why: users who never add a selection still open and close tabs all day; their records must not pile up.
  it('drops records of closed tabs when the tab list changes, keeping open ones', () => {
    const open = tabs('wt', 'tab', 256)
    setTabs({ wt: open })
    for (const tab of open) {
      recordPaneUse('wt', tab.entityId)
    }
    setTabs({ wt: [open[0]] })
    expect(paneUseRecordCountForTests()).toBe(1)
    expect(readPaneUse('wt', open[0].entityId)).toBeTypeOf('number')

    setTabs({})
    expect(paneUseRecordCountForTests()).toBe(0)
    expect(isWatchingTabsForTests()).toBe(false)
    setTabs({ wt: [open[0]] })
    recordPaneUse('wt', open[0].entityId)
    expect(isWatchingTabsForTests()).toBe(true)
  })

  it('retires a replaced tab of the same count, keeping other workspaces and shared tabs', () => {
    const shared = [liveTab('shared', 'a', 'first'), liveTab('shared', 'a', 'second')]
    const other = [liveTab('b-1', 'b')]
    setTabs({ a: [liveTab('a-1', 'a'), liveTab('a-2', 'a'), ...shared], b: other })
    for (const entityId of ['a-1', 'a-2', 'shared']) {
      recordPaneUse('a', entityId)
    }
    recordPaneUse('b', 'b-1')
    setTabs({ a: [liveTab('a-1', 'a'), liveTab('a-3', 'a'), ...shared], b: other })
    expect(readPaneUse('a', 'a-2')).toBeUndefined()
    expect(readPaneUse('a', 'a-1')).toBeTypeOf('number')
    expect(readPaneUse('b', 'b-1')).toBeTypeOf('number')
    setTabs({ a: [liveTab('a-1', 'a'), shared[1]], b: other })
    expect(readPaneUse('a', 'shared')).toBeTypeOf('number')
  })

  // Why: a click or key in a pane must not cost more as editor tabs pile up in the workspace.
  it.each([100, 1000])(
    'reads no tabs on clicks or unrelated writes with %i editor tabs',
    (count) => {
      const recorded = tabs('wt', 'chat', 200)
      const quiet = counted(tabs('quiet', 'quiet', count))
      setTabs({ wt: counted([...recorded, ...tabs('wt', 'editor', count)]), quiet })
      recordPaneUse('quiet', 'quiet-0')
      tabVisits = 0
      for (let index = 0; index < 1000; index++) {
        recordPaneUse('wt', recorded[index % recorded.length].entityId)
      }
      useAppStore.setState({ activeWorktreeId: 'wt' })
      setTabs({ ...useAppStore.getState().unifiedTabsByWorktree, fresh: [] })
      expect(tabVisits).toBe(0)

      // An activation or rename replaces one workspace's list: one pass over that list only.
      const replaced = [...recorded, ...tabs('wt', 'editor', count)]
      setTabs({ ...useAppStore.getState().unifiedTabsByWorktree, wt: counted(replaced) })
      expect(tabVisits).toBe(replaced.length)
      expect(paneUseRecordCountForTests()).toBe(201)
    }
  )
})
