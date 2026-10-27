import { describe, expect, it } from 'vitest'
import { createTestStore, makeTab } from '@/store/slices/store-test-helpers'
import { buildWorkspaceSessionPayload } from './workspace-session'

describe("the window's saved session", () => {
  it("never carries main's resume outcomes, which are live state", () => {
    const store = createTestStore()
    const tab = makeTab({
      id: 'tab-1',
      worktreeId: 'wt-1',
      ptyId: 'pty-1',
      title: 'restored',
      createdAt: 1
    })
    store.setState({
      tabsByWorktree: { 'wt-1': [tab] },
      terminalLayoutsByTabId: {
        'tab-1': {
          root: { type: 'leaf', leafId: 'leaf-1' },
          activeLeafId: 'leaf-1',
          expandedLeafId: null
        }
      },
      terminalPaneResumeOutcomesByPaneKey: {
        'tab-1:leaf-1': { ptyId: 'pty-1', ptyGeneration: 3, outcome: 'restored' }
      }
    })

    const saved = buildWorkspaceSessionPayload(store.getState())

    expect(saved).not.toHaveProperty('terminalPaneResumeOutcomesByPaneKey')
    expect(saved.tabsByWorktree).toEqual({ 'wt-1': [tab] })
    expect(saved.terminalLayoutsByTabId).toEqual(store.getState().terminalLayoutsByTabId)
  })
})
