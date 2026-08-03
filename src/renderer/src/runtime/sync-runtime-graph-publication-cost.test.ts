import { describe, expect, it } from 'vitest'
import { buildMobileSessionTabSnapshots } from './sync-runtime-graph'
import type { AppState } from '../store/types'

// Why: getBrowserTabsByWorktree reads this slice once per worktree inside the build loop,
// so a counting accessor measures per-worktree work deterministically (no timing flake).
function makeCountingState(worktreeCount: number): {
  state: AppState
  reads: () => number
  resetReads: () => void
} {
  let reads = 0
  const tabsByWorktree: Record<string, unknown[]> = {}
  for (let i = 0; i < worktreeCount; i++) {
    tabsByWorktree[`repo::/wt-${i}`] = [
      { id: `term-${i}`, title: `Agent ${i}`, customTitle: null, type: 'terminal' }
    ]
  }

  const state = {
    tabsByWorktree,
    terminalLayoutsByTabId: {},
    runtimePaneTitlesByTabId: {},
    groupsByWorktree: {},
    activeGroupIdByWorktree: {},
    unifiedTabsByWorktree: {},
    tabBarOrderByWorktree: {},
    activeFileId: null,
    activeFileIdByWorktree: {},
    openFiles: [],
    editorDrafts: {},
    activeTabId: null,
    agentStatusByPaneKey: {},
    get browserTabsByWorktree() {
      reads++
      return {}
    }
  } as unknown as AppState

  return {
    state,
    reads: () => reads,
    resetReads: () => {
      reads = 0
    }
  }
}

// Why: tab.title is read only while a worktree's snapshot content is built, so a counting
// getter measures rebuilds rather than reads — the reads above survive a cheap hoist alone.
function makeTitleCountingState(worktreeCount: number): {
  state: AppState
  titleReads: () => number
  resetTitleReads: () => void
  withOneAgentStatusChanged: () => AppState
} {
  let titleReads = 0
  const leafIdFor = (index: number): string =>
    `${String(index).padStart(8, '0')}-1111-4111-8111-111111111111`
  const makeTab = (index: number, label: string): unknown => ({
    id: `title-term-${index}`,
    customTitle: null,
    ptyId: null,
    get title() {
      titleReads++
      return label
    }
  })

  const tabsByWorktree: Record<string, unknown[]> = {}
  const terminalLayoutsByTabId: Record<string, unknown> = {}
  for (let i = 0; i < worktreeCount; i++) {
    tabsByWorktree[`repo::/title-wt-${i}`] = [makeTab(i, `Agent ${i}`)]
    terminalLayoutsByTabId[`title-term-${i}`] = {
      root: { type: 'leaf', leafId: leafIdFor(i) },
      activeLeafId: leafIdFor(i),
      expandedLeafId: null
    }
  }
  const changedPaneKey = `title-term-7:${leafIdFor(7)}`
  const agentStatusByPaneKey: AppState['agentStatusByPaneKey'] = {
    [changedPaneKey]: {
      state: 'working',
      prompt: 'Investigate publication pressure',
      updatedAt: 1_700_000_000_000,
      stateStartedAt: 1_699_999_999_000,
      agentType: 'codex',
      paneKey: changedPaneKey,
      terminalTitle: 'codex [working]',
      stateHistory: []
    }
  }

  const state = {
    tabsByWorktree,
    terminalLayoutsByTabId,
    runtimePaneTitlesByTabId: {},
    groupsByWorktree: {},
    activeGroupIdByWorktree: {},
    unifiedTabsByWorktree: {},
    tabBarOrderByWorktree: {},
    activeFileId: null,
    activeFileIdByWorktree: {},
    openFiles: [],
    editorDrafts: {},
    activeTabId: null,
    agentStatusByPaneKey,
    browserTabsByWorktree: {}
  } as unknown as AppState

  return {
    state,
    titleReads: () => titleReads,
    resetTitleReads: () => {
      titleReads = 0
    },
    withOneAgentStatusChanged: () =>
      ({
        ...state,
        agentStatusByPaneKey: {
          ...agentStatusByPaneKey,
          [changedPaneKey]: {
            ...agentStatusByPaneKey[changedPaneKey],
            state: 'waiting',
            updatedAt: 1_700_000_001_000
          }
        }
      }) as unknown as AppState
  }
}

describe('mobile session publication cost', () => {
  it('does not redo per-worktree work when nothing changed', () => {
    const WORKTREES = 300
    const { state, reads, resetReads } = makeCountingState(WORKTREES)

    buildMobileSessionTabSnapshots(state)
    resetReads()

    // Same state object, no mutation: a republish should do no per-worktree work.
    buildMobileSessionTabSnapshots(state)

    expect(reads()).toBeLessThan(WORKTREES / 10)
  })

  it('rebuilds only the worktrees whose inputs changed', () => {
    const WORKTREES = 300
    const { state, reads, resetReads } = makeCountingState(WORKTREES)

    buildMobileSessionTabSnapshots(state)
    resetReads()

    // One worktree's tabs change — the other 299 are untouched.
    const next = {
      ...state,
      tabsByWorktree: {
        ...state.tabsByWorktree,
        'repo::/wt-7': [
          { id: 'term-7', title: 'Agent 7 (done)', customTitle: null, type: 'terminal' }
        ]
      },
      get browserTabsByWorktree() {
        return (state as unknown as { browserTabsByWorktree: unknown }).browserTabsByWorktree
      }
    } as unknown as AppState

    buildMobileSessionTabSnapshots(next)

    expect(reads()).toBeLessThan(WORKTREES / 10)
  })

  it('builds no worktree content when nothing changed', () => {
    const { state, titleReads, resetTitleReads } = makeTitleCountingState(300)

    buildMobileSessionTabSnapshots(state)
    expect(titleReads()).toBeGreaterThan(0)
    resetTitleReads()

    buildMobileSessionTabSnapshots(state)

    expect(titleReads()).toBe(0)
  })

  it('builds content only for the worktree whose agent status changed', () => {
    const WORKTREES = 300
    const { state, titleReads, resetTitleReads, withOneAgentStatusChanged } =
      makeTitleCountingState(WORKTREES)

    const beforeByWorktree = new Map(
      buildMobileSessionTabSnapshots(state).map((snapshot) => [snapshot.worktree, snapshot])
    )
    const fullBuildReads = titleReads()
    resetTitleReads()

    const afterByWorktree = new Map(
      buildMobileSessionTabSnapshots(withOneAgentStatusChanged()).map((snapshot) => [
        snapshot.worktree,
        snapshot
      ])
    )
    const rebuiltWorktrees = [...afterByWorktree]
      .filter(([worktreeId, snapshot]) => snapshot !== beforeByWorktree.get(worktreeId))
      .map(([worktreeId]) => worktreeId)

    expect(titleReads()).toBeGreaterThan(0)
    expect(titleReads()).toBeLessThan(fullBuildReads / WORKTREES + 1)
    expect(rebuiltWorktrees).toEqual(['repo::/title-wt-7'])
  })
})
