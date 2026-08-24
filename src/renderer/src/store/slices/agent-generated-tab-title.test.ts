import { afterEach, describe, expect, it, vi } from 'vitest'
import { getAgentRowConversationName } from '../../../../shared/agent-row-conversation-name'
import {
  deriveGeneratedTabTitle,
  GENERATED_TAB_TITLE_SOURCE_SCAN_LIMIT
} from '../../../../shared/agent-tab-title'
import { getDefaultSettings } from '../../../../shared/constants'
import { makePaneKey } from '../../../../shared/stable-pane-id'
import { resolveTerminalTabTitle } from '../../../../shared/tab-title-resolution'
import { createTestStore, makeWorktree, seedStore } from './store-test-helpers'

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

function persistStaleSessionName(
  store: ReturnType<typeof createTestStore>,
  tabId: string,
  args: { sessionId: string; title: string; generatedTitle: string }
): void {
  const aiVaultTitle = {
    agent: 'claude' as const,
    sessionId: args.sessionId,
    title: args.title
  }
  store.setState({
    tabsByWorktree: {
      ...store.getState().tabsByWorktree,
      [WORKTREE_ID]: store
        .getState()
        .tabsByWorktree[WORKTREE_ID].map((tab) =>
          tab.id === tabId ? { ...tab, generatedTitle: args.generatedTitle, aiVaultTitle } : tab
        )
    },
    unifiedTabsByWorktree: {
      ...store.getState().unifiedTabsByWorktree,
      [WORKTREE_ID]: (store.getState().unifiedTabsByWorktree[WORKTREE_ID] ?? []).map((tab) =>
        tab.entityId === tabId ? { ...tab, generatedLabel: args.generatedTitle, aiVaultTitle } : tab
      )
    }
  })
}

describe('generated agent tab titles', () => {
  afterEach(() => {
    vi.useRealTimers()
  })

  it('stays disabled by default when agent prompts arrive', () => {
    vi.useFakeTimers()
    const store = createTestStore()
    const tabId = seedWorktree(store, false)

    store.getState().setAgentStatus(makePaneKey(tabId, LEAF_ID), {
      state: 'working',
      prompt: 'Refactor the auth middleware',
      agentType: 'codex'
    })

    expect(store.getState().tabsByWorktree[WORKTREE_ID][0].generatedTitle).toBeUndefined()
    expect(store.getState().unifiedTabsByWorktree[WORKTREE_ID][0].generatedLabel).toBeUndefined()
  })

  it('generates one stable title from the first known agent prompt when enabled', () => {
    vi.useFakeTimers()
    const store = createTestStore()
    const tabId = seedWorktree(store, true)

    store.getState().setAgentStatus(makePaneKey(tabId, LEAF_ID), {
      state: 'working',
      prompt: 'Can you please refactor the auth middleware to use JWT tokens?',
      agentType: 'codex'
    })
    store.getState().setAgentStatus(makePaneKey(tabId, LEAF_ID), {
      state: 'working',
      prompt: 'Replace this with a later task name',
      agentType: 'codex'
    })

    expect(store.getState().tabsByWorktree[WORKTREE_ID][0].generatedTitle).toBe(
      'Refactor the auth middleware to use JWT'
    )
    expect(store.getState().unifiedTabsByWorktree[WORKTREE_ID][0].generatedLabel).toBe(
      'Refactor the auth middleware to use JWT'
    )
  })

  it('replaces a raw dispatch preamble title when orchestration display metadata arrives', () => {
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

    expect(store.getState().tabsByWorktree[WORKTREE_ID][0].generatedTitle).toBe(
      'Better worker label'
    )
    expect(store.getState().unifiedTabsByWorktree[WORKTREE_ID][0].generatedLabel).toBe(
      'Better worker label'
    )
  })

  it('does not replace with sticky orchestration when a new non-dispatch prompt arrives', () => {
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
    store.getState().setRuntimeAgentOrchestrationByPaneKey({
      [paneKey]: {
        taskId: 'task-1',
        dispatchId: 'ctx-1',
        taskTitle: 'Implement worker instructions',
        displayName: 'Better worker label'
      }
    })
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

    expect(store.getState().tabsByWorktree[WORKTREE_ID][0].generatedTitle).toBe(
      'Better worker label'
    )
  })

  it('generates from a new non-dispatch prompt when sticky orchestration remains but no title exists', () => {
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
    store.getState().setRuntimeAgentOrchestrationByPaneKey({
      [paneKey]: {
        taskId: 'task-1',
        dispatchId: 'ctx-1',
        taskTitle: 'Old dispatch task',
        displayName: 'Stale worker label'
      }
    })
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

    expect(store.getState().tabsByWorktree[WORKTREE_ID][0].generatedTitle).toBe(
      'Refactor the auth middleware to use JWT'
    )
    expect(store.getState().unifiedTabsByWorktree[WORKTREE_ID][0].generatedLabel).toBe(
      'Refactor the auth middleware to use JWT'
    )
  })

  it('does not re-pin sticky task A labels onto a later dispatch task B preamble', () => {
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
    store.getState().setRuntimeAgentOrchestrationByPaneKey({
      [paneKey]: {
        taskId: 'task-a',
        dispatchId: 'ctx-a',
        taskTitle: 'Task A',
        displayName: 'Worker A label'
      }
    })
    expect(store.getState().tabsByWorktree[WORKTREE_ID][0].generatedTitle).toBe('Worker A label')

    store.getState().setAgentStatus(paneKey, {
      state: 'working',
      prompt: `You are working inside Orca, a multi-agent IDE. You are a dispatched worker.
Your task ID is: task-b

=== TASK ===
Implement task B worker instructions for the next dispatch`,
      agentType: 'codex'
    })

    expect(store.getState().tabsByWorktree[WORKTREE_ID][0].generatedTitle).toBe(
      'Implement task B worker instructions'
    )
  })

  it('does not force-replace titles when sticky orchestration updates after a non-dispatch prompt', () => {
    vi.useFakeTimers()
    const store = createTestStore()
    const tabId = seedWorktree(store, true)
    const paneKey = makePaneKey(tabId, LEAF_ID)

    store.getState().setAgentStatus(paneKey, {
      state: 'working',
      prompt: 'Can you please refactor the auth middleware to use JWT tokens?',
      agentType: 'codex'
    })
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

    expect(store.getState().tabsByWorktree[WORKTREE_ID][0].generatedTitle).toBe(
      'Refactor the auth middleware to use JWT'
    )
  })

  it('does not trim the full paste-sized prompt before generating an optional title', () => {
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

    const tab = store.getState().tabsByWorktree[WORKTREE_ID][0]
    expect(tab.generatedTitle).toBe('Fix the flaky status tests large pasted')
    expect(
      trimSpy.mock.contexts.some(
        (context) => String(context).length > GENERATED_TAB_TITLE_SOURCE_SCAN_LIMIT
      )
    ).toBe(false)
  })

  it('keeps manual rename precedence over generated and live titles', () => {
    vi.useFakeTimers()
    const store = createTestStore()
    const tabId = seedWorktree(store, true)

    store.getState().setAgentStatus(makePaneKey(tabId, LEAF_ID), {
      state: 'working',
      prompt: 'Fix the flaky status tests',
      agentType: 'claude'
    })
    store.getState().updateTabTitle(tabId, 'Claude working')
    store.getState().setTabCustomTitle(tabId, 'Status tests')

    const tab = store.getState().tabsByWorktree[WORKTREE_ID][0]
    expect(resolveTerminalTabTitle(tab, true)).toBe('Status tests')
    expect(tab.generatedTitle).toBe('Fix the flaky status tests')
  })

  it('does not generate a title for quick command labeled tabs', () => {
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

    const tab = store.getState().tabsByWorktree[WORKTREE_ID][0]
    expect(tab.generatedTitle).toBeUndefined()
    expect(resolveTerminalTabTitle(tab, true)).toBe('Run tests')
  })

  it('drops the first-prompt generated title when the pane rebinds to a new session', () => {
    vi.useFakeTimers()
    const store = createTestStore()
    const tabId = seedWorktree(store, true)
    persistStaleSessionName(store, tabId, {
      sessionId: 'claude-session-1',
      title: 'pull again',
      generatedTitle: 'Pull again'
    })

    store.getState().setAiVaultTabTitle(tabId, {
      agent: 'claude',
      sessionId: 'claude-session-2',
      title: 'Housekeeping'
    })

    const tab = store.getState().tabsByWorktree[WORKTREE_ID][0]
    const unified = store.getState().unifiedTabsByWorktree[WORKTREE_ID][0]
    expect(tab.generatedTitle).toBeUndefined()
    expect(unified.generatedLabel).toBeUndefined()
    expect(tab.aiVaultTitle).toEqual({
      agent: 'claude',
      sessionId: 'claude-session-2',
      title: 'Housekeeping'
    })
    expect(resolveTerminalTabTitle(tab, true)).toBe('Housekeeping')
    expect(getAgentRowConversationName(tab, 'claude', true)).toBe('Housekeeping')
  })

  it('heals a persisted first-prompt name when a later live session title arrives', () => {
    vi.useFakeTimers()
    const store = createTestStore()
    const tabId = seedWorktree(store, true)
    persistStaleSessionName(store, tabId, {
      sessionId: 'stale-session',
      title: 'pull again',
      generatedTitle: 'Pull again'
    })

    const stale = store.getState().tabsByWorktree[WORKTREE_ID][0]
    expect(stale.generatedTitle).toBe('Pull again')
    expect(getAgentRowConversationName(stale, 'claude', true)).toBe('pull again')

    store.getState().setAiVaultTabTitle(tabId, {
      agent: 'claude',
      sessionId: 'live-session',
      title: 'Housekeeping'
    })

    const healed = store.getState().tabsByWorktree[WORKTREE_ID][0]
    expect(healed.generatedTitle).toBeUndefined()
    expect(resolveTerminalTabTitle(healed, true)).toBe('Housekeeping')
    expect(getAgentRowConversationName(healed, 'claude', true)).toBe('Housekeeping')
  })

  it('keeps a same-session AI Vault rename on the pane label', () => {
    vi.useFakeTimers()
    const store = createTestStore()
    const tabId = seedWorktree(store, true)
    persistStaleSessionName(store, tabId, {
      sessionId: 'claude-session-1',
      title: 'pull again',
      generatedTitle: 'Pull again'
    })

    store.getState().setAiVaultTabTitle(tabId, {
      agent: 'claude',
      sessionId: 'claude-session-1',
      title: 'Housekeeping'
    })

    const tab = store.getState().tabsByWorktree[WORKTREE_ID][0]
    const unified = store.getState().unifiedTabsByWorktree[WORKTREE_ID][0]
    expect(tab.generatedTitle).toBe('Pull again')
    expect(unified.generatedLabel).toBe('Pull again')
    expect(resolveTerminalTabTitle(tab, true)).toBe('Housekeeping')
    expect(getAgentRowConversationName(tab, 'claude', true)).toBe('Housekeeping')
  })

  it('keeps the first-prompt generated title when the vault title first binds', () => {
    vi.useFakeTimers()
    const store = createTestStore()
    const tabId = seedWorktree(store, true)
    store.setState({
      tabsByWorktree: {
        ...store.getState().tabsByWorktree,
        [WORKTREE_ID]: store
          .getState()
          .tabsByWorktree[WORKTREE_ID].map((tab) =>
            tab.id === tabId ? { ...tab, generatedTitle: 'Pull again' } : tab
          )
      },
      unifiedTabsByWorktree: {
        ...store.getState().unifiedTabsByWorktree,
        [WORKTREE_ID]: (store.getState().unifiedTabsByWorktree[WORKTREE_ID] ?? []).map((tab) =>
          tab.entityId === tabId ? { ...tab, generatedLabel: 'Pull again' } : tab
        )
      }
    })

    store.getState().setAiVaultTabTitle(tabId, {
      agent: 'claude',
      sessionId: 'claude-session-1',
      title: 'Housekeeping'
    })

    store.getState().setAgentStatus(makePaneKey(tabId, LEAF_ID), {
      state: 'working',
      prompt: 'A later mid-conversation prompt about billing',
      agentType: 'claude'
    })

    const tab = store.getState().tabsByWorktree[WORKTREE_ID][0]
    const unified = store.getState().unifiedTabsByWorktree[WORKTREE_ID][0]
    expect(tab.generatedTitle).toBe('Pull again')
    expect(unified.generatedLabel).toBe('Pull again')
    expect(resolveTerminalTabTitle(tab, true)).toBe('Housekeeping')
    expect(getAgentRowConversationName(tab, 'claude', true)).toBe('Housekeeping')
  })

  it('does not restore the previous first-prompt title from a later status ping after /clear', () => {
    vi.useFakeTimers()
    const store = createTestStore()
    const tabId = seedWorktree(store, true)
    persistStaleSessionName(store, tabId, {
      sessionId: 'claude-session-1',
      title: 'pull again',
      generatedTitle: 'Pull again'
    })

    const replayedPrompt = 'pull again please'
    const replayedTitle = deriveGeneratedTabTitle(replayedPrompt)
    expect(replayedTitle).toBeTruthy()

    store.getState().setAiVaultTabTitle(tabId, null)
    store.getState().setAgentStatus(makePaneKey(tabId, LEAF_ID), {
      state: 'working',
      prompt: replayedPrompt,
      agentType: 'claude'
    })

    const tab = store.getState().tabsByWorktree[WORKTREE_ID][0]
    const unified = store.getState().unifiedTabsByWorktree[WORKTREE_ID][0]
    expect(tab.aiVaultTitle).toBeNull()
    expect(tab.generatedTitle).toBeUndefined()
    expect(unified.generatedLabel).toBeUndefined()
    expect(tab.generatedTitle).not.toBe(replayedTitle)
    expect(resolveTerminalTabTitle(tab, true)).not.toBe('Pull again')
    expect(getAgentRowConversationName(tab, 'claude', true)).not.toBe('Pull again')
  })

  it('persists an explicit clear from an absent Vault title and blocks later generation', () => {
    vi.useFakeTimers()
    const store = createTestStore()
    const tabId = seedWorktree(store, true)

    store.setState({
      tabsByWorktree: {
        ...store.getState().tabsByWorktree,
        [WORKTREE_ID]: store
          .getState()
          .tabsByWorktree[WORKTREE_ID].map((tab) =>
            tab.id === tabId ? { ...tab, generatedTitle: 'Pull again' } : tab
          )
      }
    })
    store.getState().setAiVaultTabTitle(tabId, null)
    store.getState().setAgentStatus(makePaneKey(tabId, LEAF_ID), {
      state: 'working',
      prompt: 'Restore the stale title',
      agentType: 'claude'
    })

    const tab = store.getState().tabsByWorktree[WORKTREE_ID][0]
    expect(tab.aiVaultTitle).toBeNull()
    expect(tab.generatedTitle).toBe('Pull again')
    expect(resolveTerminalTabTitle(tab, true)).not.toBe('Pull again')
  })

  it('treats repeated clears as equal and accepts the next resolved title', () => {
    const store = createTestStore()
    const tabId = seedWorktree(store, true)
    store.getState().setAiVaultTabTitle(tabId, null)
    const clearedTabs = store.getState().tabsByWorktree

    store.getState().setAiVaultTabTitle(tabId, null)
    expect(store.getState().tabsByWorktree).toBe(clearedTabs)

    store.getState().setAiVaultTabTitle(tabId, {
      agent: 'claude',
      sessionId: 'claude-session-2',
      title: 'Housekeeping'
    })
    expect(store.getState().tabsByWorktree[WORKTREE_ID][0].aiVaultTitle).toEqual({
      agent: 'claude',
      sessionId: 'claude-session-2',
      title: 'Housekeeping'
    })
  })
})
