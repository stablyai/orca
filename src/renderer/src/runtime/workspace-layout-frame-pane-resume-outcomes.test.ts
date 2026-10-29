import { describe, expect, it } from 'vitest'
import type { AppState } from '@/store/types'
import { createStore } from 'zustand/vanilla'
import { withSessionSourceWrites } from '@/store/session-source-write-boundary'
import { framePaneFactsShown, showFramePaneStarts } from './workspace-layout-frame-pane-starts'
import type {
  PublishedPane,
  PublishedWorkspaceLayout
} from '../../../shared/workspace-layout/workspace-layout-published'
import { LOCAL_EXECUTION_HOST_ID } from '../../../shared/execution-host'

const LEAF_ID = '11111111-1111-4111-8111-111111111111'
const PANE_KEY = `tab-1:${LEAF_ID}`

function frameWith(pane: Omit<PublishedPane, 'leafId'>): PublishedWorkspaceLayout {
  return {
    worktreeId: 'wt-1',
    groups: [{ id: 'g-1', tabIds: ['tab-1'] }],
    tabs: [
      {
        id: 'tab-1',
        kind: 'terminal',
        entityId: 'tab-1',
        executionHostId: LOCAL_EXECUTION_HOST_ID,
        createdAt: 1,
        customTitle: null,
        color: null,
        terminal: { root: { type: 'leaf', leafId: LEAF_ID }, panes: [{ leafId: LEAF_ID, ...pane }] }
      }
    ],
    editorFiles: [],
    browserTabs: []
  }
}

function frameStore() {
  type State = Pick<AppState, 'terminalPaneStartsByPaneKey' | 'terminalPaneResumeOutcomesByPaneKey'>
  return createStore<State>()(
    withSessionSourceWrites<State>(() => ({
      terminalPaneStartsByPaneKey: {},
      terminalPaneResumeOutcomesByPaneKey: {}
    }))
  )
}

describe("main's resume outcomes in the window's store", () => {
  it('keeps each pane’s outcome with the terminal it names, until a frame drops it', () => {
    const store = frameStore()
    const shown = framePaneFactsShown()
    const outcome = { ptyId: 'pty-1', ptyGeneration: 3, resumeOutcome: 'restored' as const }

    showFramePaneStarts(store, ['wt-1'], { 'wt-1': frameWith(outcome) }, shown)
    expect(store.getState().terminalPaneResumeOutcomesByPaneKey).toEqual({
      [PANE_KEY]: { ptyId: 'pty-1', ptyGeneration: 3, outcome: 'restored' }
    })
    expect(store.getState().terminalPaneStartsByPaneKey).toEqual({})

    showFramePaneStarts(store, ['wt-1'], { 'wt-1': frameWith({ ptyId: 'pty-2' }) }, shown)
    expect(store.getState().terminalPaneResumeOutcomesByPaneKey).toEqual({})
  })
})
