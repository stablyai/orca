import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createHookListenerState, normalizeHookPayload } from '../../../shared/agent-hook-listener'
import type { AgentStatusEntry } from '../../../shared/agent-status-types'

const dispatchTerminalNotification = vi.fn()
const dispatchAgentHookTerminalLifecycle = vi.fn()

type MockStoreState = {
  settings: {
    experimentalTerminalAttention: boolean
    notifications: { enabled: boolean; agentTaskComplete: boolean }
  }
  ptyIdsByTabId: Record<string, string[]>
  suppressedPtyExitIds: Record<string, boolean>
  tabsByWorktree: Record<string, { id: string; ptyId?: string | null }[]>
  terminalLayoutsByTabId: Record<string, never>
  agentStatusByPaneKey: Record<string, AgentStatusEntry>
}

let mockStoreState: MockStoreState

vi.mock('@/store', () => ({
  useAppStore: {
    getState: () => mockStoreState
  }
}))

vi.mock('@/components/terminal-pane/use-notification-dispatch', () => ({
  dispatchTerminalNotification
}))

vi.mock('@/components/terminal-pane/agent-hook-terminal-lifecycle', () => ({
  dispatchAgentHookTerminalLifecycle
}))

const PANE_KEY = 'tab-1:11111111-1111-4111-8111-111111111111'
const WORKTREE_ID = 'wt-1'
const HOOK_DONE_QUIET_MS = 1_500

const RUNNING_SHELL = { id: 'shell-1', type: 'shell', status: 'running' }
const FINISHED_SHELL = { id: 'shell-1', type: 'shell', status: 'completed' }

/** Replays Claude hook events through the real listener and the real completion coordinator,
 *  stamping `stateStartedAt` the way the hook server does: pinned for as long as the reported
 *  state does not change (src/main/agent-hooks/server.ts). That pinning is the reason a turn
 *  needs its own end time to be identified at all (#13245). */
function createClaudeHookReplay(): {
  emit: (payload: Record<string, unknown>) => Promise<void>
  remountCoordinator: () => Promise<void>
} {
  const listenerState = createHookListenerState()
  let pinnedState: string | null = null
  let pinnedStateStartedAt = 0

  return {
    emit: async (hookPayload) => {
      const { observeAgentHookCompletionForNotification } =
        await import('./agent-hook-completion-notifications')
      const event = normalizeHookPayload(
        listenerState,
        'claude',
        { paneKey: PANE_KEY, tabId: 'tab-1', worktreeId: WORKTREE_ID, payload: hookPayload },
        'production'
      )
      if (!event) {
        return
      }
      if (pinnedState !== event.payload.state) {
        pinnedState = event.payload.state
        pinnedStateStartedAt = Date.now()
      }
      mockStoreState.agentStatusByPaneKey[PANE_KEY] = {
        state: event.payload.state,
        prompt: event.payload.prompt,
        paneKey: PANE_KEY,
        updatedAt: Date.now(),
        stateStartedAt: pinnedStateStartedAt,
        agentType: event.payload.agentType,
        stateHistory: []
      }
      observeAgentHookCompletionForNotification({
        paneKey: PANE_KEY,
        worktreeId: WORKTREE_ID,
        payload: { ...event.payload, stateStartedAt: pinnedStateStartedAt }
      })
    },
    remountCoordinator: async () => {
      const { resetAgentHookCompletionNotificationCoordinators } =
        await import('./agent-hook-completion-notifications')
      // Why: a worktree switch tears the pane's coordinator down while the pane stays live and
      // the hook stream keeps running; the next event builds a fresh coordinator.
      resetAgentHookCompletionNotificationCoordinators()
    }
  }
}

/** Every completion banner, including one dispatched without a snapshot — an extra banner must
 *  never hide behind a missing snapshot. A `waiting`/`blocked` snapshot rides the same channel to
 *  raise "needs input" attention, which is a separate signal and not a turn completion. */
function completionSnapshots(): (
  | { lastAssistantMessage?: string; stateStartedAt?: number }
  | undefined
)[] {
  return dispatchTerminalNotification.mock.calls
    .map(([, event]) => event.agentStatusSnapshot)
    .filter((snapshot) => snapshot === undefined || snapshot.state === 'done')
}

function completionBodies(): (string | undefined)[] {
  return completionSnapshots().map((snapshot) => snapshot?.lastAssistantMessage)
}

function completionStateStartedAts(): (number | undefined)[] {
  return completionSnapshots().map((snapshot) => snapshot?.stateStartedAt)
}

describe('claude turn completions while background work keeps the pane working', () => {
  beforeEach(() => {
    vi.resetModules()
    vi.useFakeTimers()
    vi.setSystemTime(new Date('2026-01-01T00:00:00.000Z'))
    dispatchTerminalNotification.mockClear()
    dispatchAgentHookTerminalLifecycle.mockClear()
    mockStoreState = {
      settings: {
        experimentalTerminalAttention: false,
        notifications: { enabled: true, agentTaskComplete: true }
      },
      ptyIdsByTabId: { 'tab-1': ['pty-1'] },
      suppressedPtyExitIds: {},
      tabsByWorktree: { 'wt-1': [{ id: 'tab-1', ptyId: 'pty-1' }] },
      terminalLayoutsByTabId: {},
      agentStatusByPaneKey: {}
    }
  })

  afterEach(() => {
    vi.useRealTimers()
  })

  it('still notifies the turn after one that ended while a background shell ran', async () => {
    const replay = createClaudeHookReplay()

    await replay.emit({ hook_event_name: 'UserPromptSubmit', prompt: 'run the build' })
    vi.advanceTimersByTime(1_000)
    await replay.emit({
      hook_event_name: 'Stop',
      last_assistant_message: 'Build started in the background.',
      background_tasks: [RUNNING_SHELL]
    })

    // Why: the pane's stored row still says `working`, so the banner has nothing to read the
    // finished turn from unless this completion's own `done` snapshot rides with it.
    expect(dispatchTerminalNotification).toHaveBeenCalledWith(
      'wt-1',
      expect.objectContaining({
        source: 'agent-task-complete',
        paneKey: PANE_KEY,
        agentStatusSnapshot: expect.objectContaining({
          state: 'done',
          agentType: 'claude',
          prompt: 'run the build',
          lastAssistantMessage: 'Build started in the background.'
        })
      })
    )

    vi.advanceTimersByTime(5_000)
    await replay.emit({ hook_event_name: 'UserPromptSubmit', prompt: 'now lint' })
    vi.advanceTimersByTime(1_000)
    await replay.emit({
      hook_event_name: 'Stop',
      last_assistant_message: 'Lint is queued.',
      background_tasks: [FINISHED_SHELL]
    })
    vi.advanceTimersByTime(HOOK_DONE_QUIET_MS)

    // Why: the first turn's completion must not be able to swallow the next turn's — the
    // background shell never produces an all-clear of its own, so a one-shot suppression flag
    // would survive into turn N+1 and silence it (#13245).
    expect(completionBodies()).toEqual(['Build started in the background.', 'Lint is queued.'])
    // Why: two bodies are only two banners if they also build two notification ids; the pane
    // never left `working`, so both would otherwise be minted from the same pinned timestamp.
    expect(new Set(completionStateStartedAts()).size).toBe(2)
  })

  it('notifies every turn taken while a session cron keeps the pane working', async () => {
    const replay = createClaudeHookReplay()

    for (const turn of [1, 2, 3]) {
      await replay.emit({ hook_event_name: 'UserPromptSubmit', prompt: `turn ${turn}` })
      vi.advanceTimersByTime(1_000)
      await replay.emit({
        hook_event_name: 'Stop',
        last_assistant_message: `Turn ${turn} done.`,
        session_crons: [{ id: 'cron-1' }]
      })
      vi.advanceTimersByTime(5_000)
    }

    expect(completionBodies()).toEqual(['Turn 1 done.', 'Turn 2 done.', 'Turn 3 done.'])
    // Why: the pane never leaves `working`, so its stateStartedAt is pinned for the whole run.
    // Each completion must carry its own turn's end time or the built notification ids collide
    // and each banner closes the previous one.
    expect(new Set(completionStateStartedAts()).size).toBe(3)
  })

  it('does not re-announce a turn whose all-clear arrives after a child question', async () => {
    const replay = createClaudeHookReplay()

    await replay.emit({ hook_event_name: 'UserPromptSubmit', prompt: 'go' })
    await replay.emit({ hook_event_name: 'SubagentStart', agent_id: 'a1', agent_type: 'probe' })
    vi.advanceTimersByTime(1_000)
    await replay.emit({
      hook_event_name: 'Stop',
      last_assistant_message: 'Kicked off the probe.',
      background_tasks: [{ id: 'a1', type: 'subagent', status: 'running' }]
    })

    expect(completionBodies()).toEqual(['Kicked off the probe.'])

    // Why: a background child pausing for a human answer displaces the finished lead turn; the
    // turn end time has to survive that stash or the drain below reads as a second completion.
    await replay.emit({
      hook_event_name: 'PreToolUse',
      tool_name: 'AskUserQuestion',
      agent_id: 'a1',
      tool_input: { questions: [{ question: 'Continue?' }] }
    })
    await replay.emit({ hook_event_name: 'PostToolUse', tool_name: 'Read', agent_id: 'a1' })
    vi.advanceTimersByTime(2_000)
    await replay.emit({ hook_event_name: 'SubagentStop', agent_id: 'a1' })
    vi.advanceTimersByTime(HOOK_DONE_QUIET_MS)

    expect(completionBodies()).toEqual(['Kicked off the probe.'])
  })

  it('does not double-fire when the coordinator remounts before the all-clear arrives', async () => {
    const replay = createClaudeHookReplay()

    await replay.emit({ hook_event_name: 'UserPromptSubmit', prompt: 'review the PR' })
    await replay.emit({
      hook_event_name: 'SubagentStart',
      agent_id: 'a1',
      agent_type: 'general-purpose'
    })
    vi.advanceTimersByTime(1_000)
    await replay.emit({
      hook_event_name: 'Stop',
      last_assistant_message: 'Which branch should I target?',
      background_tasks: [{ id: 'a1', type: 'subagent', status: 'running' }]
    })

    expect(completionBodies()).toEqual(['Which branch should I target?'])

    await replay.remountCoordinator()

    vi.advanceTimersByTime(49_000)
    await replay.emit({ hook_event_name: 'SubagentStop', agent_id: 'a1' })
    vi.advanceTimersByTime(HOOK_DONE_QUIET_MS)

    // Why: the all-clear carries the same turn end time as the banner already shown, so the
    // fresh coordinator recognizes it as that turn's tail rather than a new completion.
    expect(completionBodies()).toEqual(['Which branch should I target?'])
    expect(dispatchAgentHookTerminalLifecycle).toHaveBeenCalledWith(
      PANE_KEY,
      expect.objectContaining({ state: 'done', agentType: 'claude' })
    )
  })
})
