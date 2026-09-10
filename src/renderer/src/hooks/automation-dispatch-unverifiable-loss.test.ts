import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { AutomationDispatchResult } from '../../../shared/automations-types'
import type { AgentStateHistoryEntry, AgentStatusEntry } from '../../../shared/agent-status-types'

let mockAgentStatusByPaneKey: Record<string, AgentStatusEntry> = {}
const storeSubscribers = new Set<() => void>()

vi.mock('@/store', () => ({
  useAppStore: {
    getState: () => ({ agentStatusByPaneKey: mockAgentStatusByPaneKey }),
    subscribe: vi.fn((subscriber: () => void) => {
      storeSubscribers.add(subscriber)
      return () => storeSubscribers.delete(subscriber)
    })
  }
}))

const markDispatchResult = vi.fn<(result: AutomationDispatchResult) => Promise<void>>()
const releaseTerminalOwnership = vi.fn()
const finalizeTerminalOwnership = vi.fn(() => false)

async function createCompletion(options: { settleDispatch?: boolean } = {}) {
  const { createAutomationDispatchCompletion } = await import('./automation-dispatch-completion')
  const completion = createAutomationDispatchCompletion({
    run: { id: 'run-1' } as never,
    prompt: 'Run the slow automation task',
    worktree: { id: 'wt-1', displayName: 'Automation worktree' } as never,
    precheckResult: null,
    markDispatchResult,
    releaseTerminalOwnership,
    finalizeTerminalOwnership
  })
  if (options.settleDispatch !== false) {
    // The dispatch itself is already recorded before any exit can settle it.
    await completion.settlePendingAfterDispatch()
  }
  markDispatchResult.mockClear()
  return completion
}

function publishAgentStatus(entry: AgentStatusEntry): void {
  mockAgentStatusByPaneKey = { [entry.paneKey]: entry }
  for (const subscriber of storeSubscribers) {
    subscriber()
  }
}

function agentStatusEntry(
  state: AgentStatusEntry['state'],
  providerSessionId: string,
  overrides: Partial<AgentStatusEntry> = {}
): AgentStatusEntry {
  const updatedAt = overrides.updatedAt ?? Date.now()
  return {
    state,
    prompt: 'Run the slow automation task',
    updatedAt,
    stateStartedAt: overrides.stateStartedAt ?? updatedAt,
    agentType: 'codex',
    paneKey: 'pane-1',
    stateHistory: overrides.stateHistory ?? [],
    providerSession: {
      key: 'session_id',
      id: providerSessionId,
      transcriptPath: `/tmp/${providerSessionId}.jsonl`
    },
    ...overrides
  }
}

function agentStateHistoryEntry(
  state: AgentStateHistoryEntry['state'],
  providerSessionId: string,
  overrides: Partial<AgentStateHistoryEntry> = {}
): AgentStateHistoryEntry {
  return {
    state,
    prompt: 'Run the slow automation task',
    startedAt: overrides.startedAt ?? Date.now(),
    providerSession: {
      key: 'session_id',
      id: providerSessionId,
      transcriptPath: `/tmp/${providerSessionId}.jsonl`
    },
    ...overrides
  }
}

/**
 * Loss of contact is never evidence of process death
 * (docs/reference/ssh-execution-boundary.md). The exit sentinel these readers
 * receive is the same one the terminal panes already classify as unverifiable.
 */
describe('automation dispatch completion on an unverifiable loss', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    mockAgentStatusByPaneKey = {}
    storeSubscribers.clear()
    markDispatchResult.mockResolvedValue(undefined)
    finalizeTerminalOwnership.mockReturnValue(false)
  })

  it('records no result, so the run keeps its non-final dispatched status', async () => {
    // A -1 is a lost relay or a synthesized host-shutdown fanout. Reporting
    // "exited with code -1" asserts a finish nobody witnessed; on SSH the
    // automation is very likely still running.
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => undefined)
    const completion = await createCompletion()

    completion.handleExit(-1)
    await vi.waitFor(() => expect(releaseTerminalOwnership).toHaveBeenCalledOnce())

    expect(markDispatchResult).not.toHaveBeenCalled()
    // Closing a terminal whose process cannot be proven dead orphans live work.
    expect(finalizeTerminalOwnership).not.toHaveBeenCalled()
    warnSpy.mockRestore()
  })

  it('still completes and finalizes a genuinely exited process', async () => {
    const completion = await createCompletion()
    finalizeTerminalOwnership.mockReturnValue(true)

    completion.handleExit(0)
    await vi.waitFor(() => expect(finalizeTerminalOwnership).toHaveBeenCalledOnce())

    expect(markDispatchResult).toHaveBeenCalledWith(
      expect.objectContaining({ runId: 'run-1', status: 'completed', error: null })
    )
    expect(releaseTerminalOwnership).not.toHaveBeenCalled()
  })

  it('still reports a real automation failure as dispatch_failed', async () => {
    const completion = await createCompletion()

    completion.handleExit(9)
    await vi.waitFor(() => expect(releaseTerminalOwnership).toHaveBeenCalledOnce())

    expect(markDispatchResult).toHaveBeenCalledWith(
      expect.objectContaining({
        runId: 'run-1',
        status: 'dispatch_failed',
        error: 'Automation process exited with code 9.'
      })
    )
    expect(finalizeTerminalOwnership).not.toHaveBeenCalled()
  })

  it('lets a later done still complete a run whose contact was lost', async () => {
    // The loss withheld a verdict rather than settling one, so positive
    // evidence arriving afterwards must still be able to close the run.
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => undefined)
    const completion = await createCompletion()

    completion.handleExit(-1)
    await vi.waitFor(() => expect(releaseTerminalOwnership).toHaveBeenCalledOnce())
    completion.handleAgentDone()

    await vi.waitFor(() =>
      expect(markDispatchResult).toHaveBeenCalledWith(
        expect.objectContaining({ status: 'completed' })
      )
    )
    warnSpy.mockRestore()
  })

  it('ignores a done status from another provider session in the same pane', async () => {
    const completion = await createCompletion()
    completion.observeAgentStatus('pane-1', 1000)

    publishAgentStatus(agentStatusEntry('working', 'main-session', { updatedAt: 1001 }))
    publishAgentStatus(
      agentStatusEntry('working', 'title-session', {
        prompt: 'Generate a concise, single-line task title',
        providerSession: { key: 'session_id', id: 'title-session' },
        updatedAt: 1002
      })
    )
    publishAgentStatus(
      agentStatusEntry('done', 'title-session', {
        prompt: 'Generate a concise, single-line task title',
        lastAssistantMessage: '{"title":"Run slow task"}',
        providerSession: { key: 'session_id', id: 'title-session' },
        updatedAt: 1003
      })
    )
    await Promise.resolve()

    expect(markDispatchResult).not.toHaveBeenCalled()

    publishAgentStatus(
      agentStatusEntry('done', 'main-session', {
        lastAssistantMessage: 'Run completed',
        updatedAt: 1004
      })
    )

    await vi.waitFor(() =>
      expect(markDispatchResult).toHaveBeenCalledWith(
        expect.objectContaining({
          runId: 'run-1',
          status: 'completed',
          outputSnapshot: expect.objectContaining({ content: 'Run completed' })
        })
      )
    )
  })

  it('does not bind the run to a mismatched transcript-backed working status', async () => {
    const completion = await createCompletion()
    completion.observeAgentStatus('pane-1', 1000)

    publishAgentStatus(
      agentStatusEntry('working', 'title-session', {
        prompt: 'Generate a concise, single-line task title',
        updatedAt: 1001
      })
    )
    publishAgentStatus(
      agentStatusEntry('done', 'title-session', {
        prompt: 'Generate a concise, single-line task title',
        lastAssistantMessage: '{"title":"Run slow task"}',
        updatedAt: 1002
      })
    )
    await Promise.resolve()

    expect(markDispatchResult).not.toHaveBeenCalled()

    publishAgentStatus(agentStatusEntry('working', 'main-session', { updatedAt: 1003 }))
    publishAgentStatus(
      agentStatusEntry('done', 'main-session', {
        lastAssistantMessage: 'Run completed',
        updatedAt: 1004
      })
    )

    await vi.waitFor(() =>
      expect(markDispatchResult).toHaveBeenCalledWith(
        expect.objectContaining({
          runId: 'run-1',
          status: 'completed',
          outputSnapshot: expect.objectContaining({ content: 'Run completed' })
        })
      )
    )
  })

  it('rejects sessionless store done statuses after the run session is known', async () => {
    const completion = await createCompletion()
    completion.observeAgentStatus('pane-1', 1000)

    publishAgentStatus(agentStatusEntry('working', 'main-session', { updatedAt: 1001 }))
    publishAgentStatus(
      agentStatusEntry('done', 'sessionless', {
        lastAssistantMessage: 'sessionless done',
        providerSession: undefined,
        updatedAt: 1002
      })
    )
    await Promise.resolve()

    expect(markDispatchResult).not.toHaveBeenCalled()

    publishAgentStatus(
      agentStatusEntry('done', 'main-session', {
        lastAssistantMessage: 'Run completed',
        updatedAt: 1003
      })
    )

    await vi.waitFor(() =>
      expect(markDispatchResult).toHaveBeenCalledWith(
        expect.objectContaining({
          runId: 'run-1',
          status: 'completed',
          outputSnapshot: expect.objectContaining({ content: 'Run completed' })
        })
      )
    )
  })

  it('recovers the target session from state history when observing after the turn completed', async () => {
    const completion = await createCompletion()

    publishAgentStatus(
      agentStatusEntry('done', 'sessionless', {
        lastCompletedAssistantMessage: 'Run completed from history',
        providerSession: undefined,
        updatedAt: 1004,
        stateHistory: [
          agentStateHistoryEntry('working', 'main-session', { startedAt: 1001 }),
          agentStateHistoryEntry('done', 'main-session', { startedAt: 1003 })
        ]
      })
    )
    completion.observeAgentStatus('pane-1', 1000, { requireWorkingAfterStart: true })

    await vi.waitFor(() =>
      expect(markDispatchResult).toHaveBeenCalledWith(
        expect.objectContaining({
          runId: 'run-1',
          status: 'completed',
          outputSnapshot: expect.objectContaining({ content: 'Run completed from history' })
        })
      )
    )
  })

  it('does not overlap pi history rows that share an id but have different transcript files', async () => {
    const { getAutomationAgentStateHistoryOverlap } =
      await import('./automation-dispatch-agent-status-match')
    const previous = [
      agentStateHistoryEntry('working', 'shared-id', {
        providerSession: { key: 'session_id', id: 'shared-id', transcriptPath: '/tmp/first.jsonl' },
        startedAt: 1001
      })
    ]
    const current = [
      agentStateHistoryEntry('working', 'shared-id', {
        providerSession: {
          key: 'session_id',
          id: 'shared-id',
          transcriptPath: '/tmp/second.jsonl'
        },
        startedAt: 1001
      })
    ]

    expect(getAutomationAgentStateHistoryOverlap('pi', previous, current)).toBe(0)
    expect(getAutomationAgentStateHistoryOverlap('codex', previous, current)).toBe(1)
  })

  it('does not settle an early direct done before this run starts working', async () => {
    const completion = await createCompletion({ settleDispatch: false })

    completion.handleAgentStatusPayload(
      {
        state: 'done',
        prompt: 'Run the slow automation task',
        lastAssistantMessage: 'early done'
      } as never,
      { requireWorkingAfterStart: true }
    )
    await completion.settlePendingAfterDispatch()
    await Promise.resolve()

    expect(markDispatchResult).not.toHaveBeenCalled()

    completion.handleAgentStatusPayload(
      { state: 'working', prompt: 'Run the slow automation task' } as never,
      { requireWorkingAfterStart: true }
    )
    completion.handleAgentStatusPayload(
      {
        state: 'done',
        prompt: 'Run the slow automation task',
        lastAssistantMessage: 'Run completed'
      } as never,
      { requireWorkingAfterStart: true }
    )

    await vi.waitFor(() =>
      expect(markDispatchResult).toHaveBeenCalledWith(
        expect.objectContaining({
          runId: 'run-1',
          status: 'completed',
          outputSnapshot: expect.objectContaining({ content: 'Run completed' })
        })
      )
    )
  })

  it('ignores direct title-generation status even when it embeds the run prompt', async () => {
    const completion = await createCompletion()
    const titlePrompt =
      'Generate a concise, single-line task title for: Run the slow automation task'

    completion.handleAgentStatusPayload(
      { state: 'working', prompt: 'Run the slow automation task' } as never,
      { requireWorkingAfterStart: true }
    )
    completion.handleAgentStatusPayload({ state: 'working', prompt: titlePrompt } as never, {
      requireWorkingAfterStart: true
    })
    completion.handleAgentStatusPayload(
      {
        state: 'done',
        prompt: titlePrompt,
        lastAssistantMessage: '{"title":"Run slow task"}'
      } as never,
      { requireWorkingAfterStart: true }
    )
    await Promise.resolve()

    expect(markDispatchResult).not.toHaveBeenCalled()

    completion.handleAgentStatusPayload(
      {
        state: 'done',
        prompt: 'Run the slow automation task',
        lastAssistantMessage: 'Run completed'
      } as never,
      { requireWorkingAfterStart: true }
    )

    await vi.waitFor(() =>
      expect(markDispatchResult).toHaveBeenCalledWith(
        expect.objectContaining({
          runId: 'run-1',
          status: 'completed',
          outputSnapshot: expect.objectContaining({ content: 'Run completed' })
        })
      )
    )
  })
})
