import { afterEach, describe, expect, it, vi } from 'vitest'
import { getDefaultSettings } from '../../../../shared/constants'
import { makePaneKey } from '../../../../shared/stable-pane-id'
import { createTestStore, makeWorktree, seedStore } from './store-test-helpers'

const WORKTREE_ID = 'repo1::/path/wt1'
const LEAF_A = '11111111-1111-4111-8111-111111111111'
const LEAF_B = '22222222-2222-4222-8222-222222222222'
const DISPATCH_PROMPT = `You are working inside Orca, a multi-agent IDE. You are a dispatched worker.
Your task ID is: task-1

=== CLI COMMANDS ===
orca orchestration send --to term_parent

=== TASK ===
Implement the detailed worker instructions that should not be the short label`

function seedSplitTab(store: ReturnType<typeof createTestStore>): string {
  seedStore(store, {
    settings: { ...getDefaultSettings('/tmp'), tabAutoGenerateTitle: true },
    worktreesByRepo: {
      repo1: [makeWorktree({ id: WORKTREE_ID, repoId: 'repo1', path: '/path/wt1' })]
    }
  })
  return store.getState().createTab(WORKTREE_ID).id
}

function generatedTitleOf(store: ReturnType<typeof createTestStore>) {
  const { generatedTitle, generatedTitlePaneKey } = store.getState().tabsByWorktree[WORKTREE_ID][0]
  return { generatedTitle, generatedTitlePaneKey }
}

describe('generated tab title source pane', () => {
  afterEach(() => {
    vi.useRealTimers()
  })

  it('records the pane whose prompt produced the title and keeps it when a sibling starts', () => {
    vi.useFakeTimers()
    const store = createTestStore()
    const tabId = seedSplitTab(store)

    store.getState().setAgentStatus(makePaneKey(tabId, LEAF_A), {
      state: 'working',
      prompt: 'Fix the patient intake flow in the portal',
      agentType: 'claude'
    })
    store.getState().setAgentStatus(makePaneKey(tabId, LEAF_B), {
      state: 'working',
      prompt: 'Design a Redis cache strategy for sessions',
      agentType: 'codex'
    })

    expect(generatedTitleOf(store)).toEqual({
      generatedTitle: 'Fix the patient intake flow in the',
      generatedTitlePaneKey: makePaneKey(tabId, LEAF_A)
    })
  })

  it('moves the source to the pane whose dispatch replaces the title', () => {
    vi.useFakeTimers()
    const store = createTestStore()
    const tabId = seedSplitTab(store)
    const paneB = makePaneKey(tabId, LEAF_B)

    store.getState().setAgentStatus(makePaneKey(tabId, LEAF_A), {
      state: 'working',
      prompt: 'Fix the patient intake flow in the portal',
      agentType: 'claude'
    })
    store.getState().setAgentStatus(paneB, {
      state: 'working',
      prompt: DISPATCH_PROMPT,
      agentType: 'codex'
    })
    store.getState().setRuntimeAgentOrchestrationByPaneKey({
      [paneB]: { taskId: 'task-1', dispatchId: 'ctx-1', displayName: 'Better worker label' }
    })

    expect(generatedTitleOf(store)).toEqual({
      generatedTitle: 'Better worker label',
      generatedTitlePaneKey: paneB
    })
  })
})
