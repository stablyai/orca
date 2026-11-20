import { expect, it } from 'vitest'
import type { Tab } from '../../../../../../shared/workspace-layout/tab-groups/tab-types'
import type { AppState } from '../../../types'
import { carryChatReadMarks } from './chat-read-mark-carry'

const LEAF = '2b8ea975-8113-41ae-a25c-feb50cbe084a'

function chatTab(id: string, entityId: string): Tab {
  return {
    id,
    entityId,
    groupId: 'g',
    worktreeId: 'wt',
    contentType: 'agent-session',
    label: 'Chat',
    customLabel: null,
    color: null,
    sortOrder: 0,
    createdAt: 0
  }
}

/** Counts every element read from the workspace's tab list. */
function countedTabs(tabs: Tab[]): { tabs: Tab[]; reads: () => number } {
  let reads = 0
  const counted = new Proxy(tabs, {
    get(target, property, receiver) {
      if (typeof property === 'string' && /^\d+$/.test(property)) {
        reads++
      }
      return Reflect.get(target, property, receiver)
    }
  })
  return { tabs: counted, reads: () => reads }
}

function run(n: number): { reads: number; publications: number } {
  const tabs = Array.from({ length: n }, (_, index) =>
    chatTab(`structured-agent-session-old-${index}`, `sess-${index}`)
  )
  tabs.push(chatTab('structured-agent-session-old', 'sess-2'))
  const counted = countedTabs(tabs)
  let state: Pick<
    AppState,
    | 'unifiedTabsByWorktree'
    | 'acknowledgedAgentsByPaneKey'
    | 'activityClearedAtByPaneKey'
    | 'manuallyUnreadTurnsByPaneKey'
  > = {
    unifiedTabsByWorktree: { wt: counted.tabs },
    acknowledgedAgentsByPaneKey: { [`structured-agent-session-old:${LEAF}`]: 100 },
    activityClearedAtByPaneKey: {},
    manuallyUnreadTurnsByPaneKey: {}
  }
  let publications = 0
  const store = {
    // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: the carry reads only these four fields.
    getState: () => state as AppState,
    setState: (patch: Partial<AppState>) => {
      publications++
      state = { ...state, ...patch }
    }
  }
  carryChatReadMarks(store, ['wt'])
  const afterFirst = { reads: counted.reads(), publications }
  // Status-only host patches keep the same tab list: no further carry work.
  for (let index = 0; index < 50; index++) {
    carryChatReadMarks(store, ['wt'])
  }
  expect(afterFirst.publications).toBe(1)
  return {
    reads: counted.reads() - afterFirst.reads,
    publications: publications - afterFirst.publications
  }
}

it('checks a workspace tab list once, however many host patches follow', () => {
  expect(run(100)).toEqual({ reads: 0, publications: 0 })
  expect(run(1000)).toEqual({ reads: 0, publications: 0 })
})

it('rechecks a checked tab list when a sync brings tab-keyed marks', () => {
  const tab = chatTab('structured-agent-session-old', 'sess-2')
  const tabs = [tab]
  let state: Pick<
    AppState,
    | 'unifiedTabsByWorktree'
    | 'acknowledgedAgentsByPaneKey'
    | 'activityClearedAtByPaneKey'
    | 'manuallyUnreadTurnsByPaneKey'
  > = {
    unifiedTabsByWorktree: { wt: tabs },
    acknowledgedAgentsByPaneKey: {},
    activityClearedAtByPaneKey: {},
    manuallyUnreadTurnsByPaneKey: {}
  }
  const store = {
    // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: the carry reads only these four fields.
    getState: () => state as AppState,
    setState: (patch: Partial<AppState>) => {
      state = { ...state, ...patch }
    }
  }
  carryChatReadMarks(store, ['wt'])
  state = {
    ...state,
    acknowledgedAgentsByPaneKey: { [`structured-agent-session-old:${LEAF}`]: 100 }
  }
  carryChatReadMarks(store, ['wt'])
  expect(state.acknowledgedAgentsByPaneKey).toEqual({
    [`structured-agent-session-sess-2:${LEAF}`]: 100
  })
})

it('does no tab work for retitled or reordered tabs once every saved mark has moved', () => {
  for (const n of [100, 1000]) {
    const tabs = Array.from({ length: n }, (_, index) =>
      chatTab(`structured-agent-session-old-${index}`, `sess-${index}`)
    )
    let reads = 0
    let state: Pick<
      AppState,
      | 'unifiedTabsByWorktree'
      | 'acknowledgedAgentsByPaneKey'
      | 'activityClearedAtByPaneKey'
      | 'manuallyUnreadTurnsByPaneKey'
    > = {
      unifiedTabsByWorktree: {},
      acknowledgedAgentsByPaneKey: { [`structured-agent-session-sess-2:${LEAF}`]: 100 },
      activityClearedAtByPaneKey: {},
      manuallyUnreadTurnsByPaneKey: {}
    }
    const store = {
      // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: the carry reads only these four fields.
      getState: () => state as AppState,
      setState: (patch: Partial<AppState>) => {
        state = { ...state, ...patch }
      }
    }
    for (let update = 0; update < 50; update++) {
      // Each title change replaces the workspace's tab list.
      const counted = new Proxy(
        tabs.map((tab) => ({ ...tab, label: `Chat ${update}` })),
        {
          get(target, property, receiver) {
            if (typeof property === 'string' && /^\d+$/.test(property)) {
              reads++
            }
            return Reflect.get(target, property, receiver)
          }
        }
      )
      state = { ...state, unifiedTabsByWorktree: { wt: counted } }
      carryChatReadMarks(store, ['wt'])
    }
    expect(reads).toBe(0)
  }
})
