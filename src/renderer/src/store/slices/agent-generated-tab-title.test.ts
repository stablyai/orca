import { afterEach, describe, expect, it, vi } from 'vitest'
import { GENERATED_TAB_TITLE_SOURCE_SCAN_LIMIT } from '../../../../shared/agent-tab-title'
import { getDefaultSettings } from '../../../../shared/constants'
import { makePaneKey } from '../../../../shared/stable-pane-id'
import { resolveTerminalTabTitle } from '../../../../shared/tab-title-resolution'
import { createTestStore, makeWorktree, seedStore } from './store-test-helpers'
import { layoutApplyTestTransport } from '@/runtime/layout-apply-test-transport.test-fixture'

// Main's answer to the window's layout commands, as a switch-on build sends them.
vi.mock('@/runtime/runtime-rpc-client', async (importOriginal) =>
  (
    await import('@/runtime/layout-apply-test-transport.test-fixture')
  ).runtimeRpcClientWithLayoutApply(await importOriginal())
)

const WORKTREE_ID = 'repo1::/path/wt1'
const LEAF_ID = '11111111-1111-4111-8111-111111111111'

function seedWorktree(store: ReturnType<typeof createTestStore>, enabled: boolean): string {
  seedStore(store, {
    settings: {
      ...getDefaultSettings('/tmp'),
      tabAutoGenerateTitle: enabled
    },
    worktreesByRepo: {
      repo1: [makeWorktree({ id: WORKTREE_ID, repoId: 'repo1', path: '/path/wt1' })]
    }
  })
  return store.getState().createTab(WORKTREE_ID).id
}

describe('generated agent tab titles', () => {
  afterEach(() => {
    vi.useRealTimers()
  })

  it('stays disabled by default when agent prompts arrive', async () => {
    vi.useFakeTimers()
    const store = createTestStore()
    const tabId = seedWorktree(store, false)

    store.getState().setAgentStatus(makePaneKey(tabId, LEAF_ID), {
      state: 'working',
      prompt: 'Refactor the auth middleware',
      agentType: 'codex'
    })
    await layoutApplyTestTransport.settle()

    expect(store.getState().tabsByWorktree[WORKTREE_ID][0].generatedTitle).toBeUndefined()
    expect(store.getState().unifiedTabsByWorktree[WORKTREE_ID][0].generatedLabel).toBeUndefined()
  })

  it('generates one stable title from the first known agent prompt when enabled', async () => {
    vi.useFakeTimers()
    const store = createTestStore()
    const tabId = seedWorktree(store, true)

    store.getState().setAgentStatus(makePaneKey(tabId, LEAF_ID), {
      state: 'working',
      prompt: 'Can you please refactor the auth middleware to use JWT tokens?',
      agentType: 'codex'
    })
    await layoutApplyTestTransport.settle()
    store.getState().setAgentStatus(makePaneKey(tabId, LEAF_ID), {
      state: 'working',
      prompt: 'Replace this with a later task name',
      agentType: 'codex'
    })
    await layoutApplyTestTransport.settle()

    expect(store.getState().tabsByWorktree[WORKTREE_ID][0].generatedTitle).toBe(
      'Refactor the auth middleware to use JWT'
    )
    expect(store.getState().unifiedTabsByWorktree[WORKTREE_ID][0].generatedLabel).toBe(
      'Refactor the auth middleware to use JWT'
    )
  })

  it('replaces a raw dispatch preamble title when orchestration display metadata arrives', async () => {
    vi.useFakeTimers()
    const store = createTestStore()
    const tabId = seedWorktree(store, true)
    const paneKey = makePaneKey(tabId, LEAF_ID)

    store.getState().setAgentStatus(paneKey, {
      state: 'working',
      prompt: `You are working inside Orca, a multi-agent IDE. You are a dispatched worker.
Your task ID is: task-1

=== CLI COMMANDS ===
orca orchestration send --to term_parent

=== TASK ===
Implement the detailed worker instructions that should not be the short label`,
      agentType: 'codex'
    })
    await layoutApplyTestTransport.settle()

    expect(store.getState().tabsByWorktree[WORKTREE_ID][0].generatedTitle).toBe(
      'Implement the detailed worker'
    )

    store.getState().setRuntimeAgentOrchestrationByPaneKey({
      [paneKey]: {
        taskId: 'task-1',
        dispatchId: 'ctx-1',
        taskTitle: 'Implement worker instructions',
        displayName: 'Better worker label'
      }
    })
    await layoutApplyTestTransport.settle()

    expect(store.getState().tabsByWorktree[WORKTREE_ID][0].generatedTitle).toBe(
      'Better worker label'
    )
    expect(store.getState().unifiedTabsByWorktree[WORKTREE_ID][0].generatedLabel).toBe(
      'Better worker label'
    )
  })

  it('does not replace with sticky orchestration when a new non-dispatch prompt arrives', async () => {
    vi.useFakeTimers()
    const store = createTestStore()
    const tabId = seedWorktree(store, true)
    const paneKey = makePaneKey(tabId, LEAF_ID)
    const dispatchPrompt = `You are working inside Orca, a multi-agent IDE. You are a dispatched worker.
Your task ID is: task-1

=== CLI COMMANDS ===
orca orchestration send --to term_parent

=== TASK ===
Implement the detailed worker instructions that should not be the short label`

    store.getState().setAgentStatus(paneKey, {
      state: 'working',
      prompt: dispatchPrompt,
      agentType: 'codex'
    })
    await layoutApplyTestTransport.settle()
    store.getState().setRuntimeAgentOrchestrationByPaneKey({
      [paneKey]: {
        taskId: 'task-1',
        dispatchId: 'ctx-1',
        taskTitle: 'Implement worker instructions',
        displayName: 'Better worker label'
      }
    })
    await layoutApplyTestTransport.settle()
    expect(store.getState().tabsByWorktree[WORKTREE_ID][0].generatedTitle).toBe(
      'Better worker label'
    )

    // Why: orchestration metadata is sticky (~30m). A later non-dispatch turn on
    // the same pane must first-write-wins — not re-assert the old dispatch name.
    store.getState().setAgentStatus(paneKey, {
      state: 'working',
      prompt: 'Refactor the auth middleware to use JWT tokens for session recovery',
      agentType: 'codex'
    })
    await layoutApplyTestTransport.settle()

    expect(store.getState().tabsByWorktree[WORKTREE_ID][0].generatedTitle).toBe(
      'Better worker label'
    )
  })

  it('generates from a new non-dispatch prompt when sticky orchestration remains but no title exists', async () => {
    vi.useFakeTimers()
    const store = createTestStore()
    const tabId = seedWorktree(store, true)
    const paneKey = makePaneKey(tabId, LEAF_ID)

    // Seed sticky orchestration without a prior generated title (e.g. feature was off).
    store.getState().setAgentStatus(paneKey, {
      state: 'done',
      prompt: `You are working inside Orca, a multi-agent IDE. You are a dispatched worker.
Your task ID is: task-1

=== TASK ===
Old dispatch task that already finished`,
      agentType: 'codex'
    })
    await layoutApplyTestTransport.settle()
    store.getState().setRuntimeAgentOrchestrationByPaneKey({
      [paneKey]: {
        taskId: 'task-1',
        dispatchId: 'ctx-1',
        taskTitle: 'Old dispatch task',
        displayName: 'Stale worker label'
      }
    })
    await layoutApplyTestTransport.settle()
    // Clear any title set during the dispatch turn so the next non-dispatch
    // prompt is a pure first-write with sticky orchestration still present.
    const tabs = store.getState().tabsByWorktree[WORKTREE_ID]
    store.setState({
      tabsByWorktree: {
        ...store.getState().tabsByWorktree,
        [WORKTREE_ID]: tabs.map((tab) =>
          tab.id === tabId ? { ...tab, generatedTitle: undefined } : tab
        )
      },
      unifiedTabsByWorktree: {
        ...store.getState().unifiedTabsByWorktree,
        [WORKTREE_ID]: (store.getState().unifiedTabsByWorktree[WORKTREE_ID] ?? []).map((tab) =>
          tab.id === tabId ? { ...tab, generatedLabel: undefined } : tab
        )
      }
    })

    store.getState().setAgentStatus(paneKey, {
      state: 'working',
      prompt: 'Can you please refactor the auth middleware to use JWT tokens?',
      agentType: 'codex'
    })
    await layoutApplyTestTransport.settle()

    expect(store.getState().tabsByWorktree[WORKTREE_ID][0].generatedTitle).toBe(
      'Refactor the auth middleware to use JWT'
    )
    expect(store.getState().unifiedTabsByWorktree[WORKTREE_ID][0].generatedLabel).toBe(
      'Refactor the auth middleware to use JWT'
    )
  })

  it('does not re-pin sticky task A labels onto a later dispatch task B preamble', async () => {
    vi.useFakeTimers()
    const store = createTestStore()
    const tabId = seedWorktree(store, true)
    const paneKey = makePaneKey(tabId, LEAF_ID)

    store.getState().setAgentStatus(paneKey, {
      state: 'working',
      prompt: `You are working inside Orca, a multi-agent IDE. You are a dispatched worker.
Your task ID is: task-a

=== TASK ===
Implement task A worker instructions that should not stick`,
      agentType: 'codex'
    })
    await layoutApplyTestTransport.settle()
    store.getState().setRuntimeAgentOrchestrationByPaneKey({
      [paneKey]: {
        taskId: 'task-a',
        dispatchId: 'ctx-a',
        taskTitle: 'Task A',
        displayName: 'Worker A label'
      }
    })
    await layoutApplyTestTransport.settle()
    expect(store.getState().tabsByWorktree[WORKTREE_ID][0].generatedTitle).toBe('Worker A label')

    store.getState().setAgentStatus(paneKey, {
      state: 'working',
      prompt: `You are working inside Orca, a multi-agent IDE. You are a dispatched worker.
Your task ID is: task-b

=== TASK ===
Implement task B worker instructions for the next dispatch`,
      agentType: 'codex'
    })
    await layoutApplyTestTransport.settle()

    expect(store.getState().tabsByWorktree[WORKTREE_ID][0].generatedTitle).toBe(
      'Implement task B worker instructions'
    )
  })

  it('does not force-replace titles when sticky orchestration updates after a non-dispatch prompt', async () => {
    vi.useFakeTimers()
    const store = createTestStore()
    const tabId = seedWorktree(store, true)
    const paneKey = makePaneKey(tabId, LEAF_ID)

    store.getState().setAgentStatus(paneKey, {
      state: 'working',
      prompt: 'Can you please refactor the auth middleware to use JWT tokens?',
      agentType: 'codex'
    })
    await layoutApplyTestTransport.settle()
    expect(store.getState().tabsByWorktree[WORKTREE_ID][0].generatedTitle).toBe(
      'Refactor the auth middleware to use JWT'
    )

    store.getState().setRuntimeAgentOrchestrationByPaneKey({
      [paneKey]: {
        taskId: 'task-1',
        dispatchId: 'ctx-1',
        taskTitle: 'Stale orchestration task',
        displayName: 'Stale orchestration label'
      }
    })
    await layoutApplyTestTransport.settle()

    expect(store.getState().tabsByWorktree[WORKTREE_ID][0].generatedTitle).toBe(
      'Refactor the auth middleware to use JWT'
    )
  })

  it('does not trim the full paste-sized prompt before generating an optional title', async () => {
    vi.useFakeTimers()
    const trimSpy = vi.spyOn(String.prototype, 'trim')
    const store = createTestStore()
    const tabId = seedWorktree(store, true)
    const prompt = `Fix the flaky status tests ${'large pasted text '.repeat(5000)}`

    store.getState().setAgentStatus(makePaneKey(tabId, LEAF_ID), {
      state: 'working',
      prompt,
      agentType: 'codex'
    })
    await layoutApplyTestTransport.settle()

    const tab = store.getState().tabsByWorktree[WORKTREE_ID][0]
    expect(tab.generatedTitle).toBe('Fix the flaky status tests large pasted')
    expect(
      trimSpy.mock.contexts.some(
        (context) => String(context).length > GENERATED_TAB_TITLE_SOURCE_SCAN_LIMIT
      )
    ).toBe(false)
  })

  it('keeps manual rename precedence over generated and live titles', async () => {
    vi.useFakeTimers()
    const store = createTestStore()
    const tabId = seedWorktree(store, true)

    store.getState().setAgentStatus(makePaneKey(tabId, LEAF_ID), {
      state: 'working',
      prompt: 'Fix the flaky status tests',
      agentType: 'claude'
    })
    await layoutApplyTestTransport.settle()
    store.getState().updateTabTitle(tabId, 'Claude working')
    await layoutApplyTestTransport.settle()
    store.getState().setTabCustomTitle(tabId, 'Status tests')
    await layoutApplyTestTransport.settle()

    const tab = store.getState().tabsByWorktree[WORKTREE_ID][0]
    expect(resolveTerminalTabTitle(tab, true)).toBe('Status tests')
    expect(tab.generatedTitle).toBe('Fix the flaky status tests')
  })

  it('does not generate a title for quick command labeled tabs', async () => {
    vi.useFakeTimers()
    const store = createTestStore()
    seedStore(store, {
      settings: {
        ...getDefaultSettings('/tmp'),
        tabAutoGenerateTitle: true
      },
      worktreesByRepo: {
        repo1: [makeWorktree({ id: WORKTREE_ID, repoId: 'repo1', path: '/path/wt1' })]
      }
    })
    const tabId = store
      .getState()
      .createTab(WORKTREE_ID, undefined, undefined, { quickCommandLabel: 'Run tests' }).id

    store.getState().setAgentStatus(makePaneKey(tabId, LEAF_ID), {
      state: 'working',
      prompt: 'Fix the flaky status tests',
      agentType: 'claude'
    })
    await layoutApplyTestTransport.settle()

    const tab = store.getState().tabsByWorktree[WORKTREE_ID][0]
    expect(tab.generatedTitle).toBeUndefined()
    expect(resolveTerminalTabTitle(tab, true)).toBe('Run tests')
  })
})
