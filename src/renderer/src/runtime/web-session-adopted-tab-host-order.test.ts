// @vitest-environment happy-dom
import { beforeEach, expect, it } from 'vitest'
import './web-session-tabs-sync/terminal-surfaces'
import { applyWebSessionTabsSnapshot } from './web-session-tabs-sync/snapshot-api'
import {
  makeSnapshot,
  makeState,
  resetWebSessionTabsSyncTestState,
  WT,
  ENV,
  NOW
} from './web-session-tabs-sync-test-harness'

beforeEach(resetWebSessionTabsSyncTestState)

const options = {
  contentScope: 'agent-session',
  preserveLocalLayout: true,
  terminalPtyMode: 'local'
} as const

function chat(sessionId: string) {
  return {
    type: 'agent-session' as const,
    id: `agent-session:${sessionId}`,
    sessionId,
    agent: 'codex' as const,
    title: sessionId,
    isActive: false
  }
}

function hostSnapshot(sessionIds: string[]) {
  return makeSnapshot(sessionIds.map(chat), {
    activeTabType: 'agent-session',
    tabGroups: [
      {
        id: 'host-group-1',
        activeTabId: null,
        tabOrder: sessionIds.map((sessionId) => `agent-session:${sessionId}`)
      }
    ]
  })
}

/** The order the desktop draws, by session, in the one group it keeps. */
function drawnOrder(state: ReturnType<typeof makeState>): string[] {
  const tabs = state.unifiedTabsByWorktree[WT] ?? []
  return (state.groupsByWorktree[WT]?.[0]?.tabOrder ?? []).map(
    (tabId) => tabs.find((tab) => tab.id === tabId)?.entityId ?? tabId
  )
}

function apply(state: ReturnType<typeof makeState>, sessionIds: string[], at: number) {
  return {
    ...state,
    ...applyWebSessionTabsSnapshot(state, hostSnapshot(sessionIds), ENV, at, options)
  }
}

it('adopts a new chat where the host placed it, after its source rather than at the end', () => {
  const before = apply(makeState(), ['source', 'b'], NOW)
  expect(drawnOrder(before)).toEqual(['source', 'b'])

  const after = apply(before, ['source', 'child', 'b'], NOW + 1)

  expect(drawnOrder(after)).toEqual(['source', 'child', 'b'])
})

it('keeps a tab the user moved where they put it when the host republishes', () => {
  const adopted = apply(apply(makeState(), ['source', 'b'], NOW), ['source', 'child', 'b'], NOW + 1)
  const [group] = adopted.groupsByWorktree[WT]!
  const [source, child, b] = group!.tabOrder
  const moved = {
    ...adopted,
    groupsByWorktree: { [WT]: [{ ...group!, tabOrder: [child!, b!, source!] }] }
  }

  const republished = apply(moved, ['source', 'child', 'b'], NOW + 2)

  expect(drawnOrder(republished)).toEqual(['child', 'b', 'source'])
})
