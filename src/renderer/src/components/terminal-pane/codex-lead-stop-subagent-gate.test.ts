import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  createAgentCompletionCoordinator,
  resetAgentCompletionCoordinatorIdentitiesForTest
} from './agent-completion-coordinator'
import { dispatchTerminalNotification } from './use-notification-dispatch'
import {
  createHookListenerState,
  normalizeHookPayload,
  reconcileRemoteCodexState,
  type HookListenerState
} from '../../../../shared/agent-hook-listener'
import type { AgentHookSource } from '../../../../shared/agent-hook-relay'
import type { AgentStatusEntry } from '../../../../shared/agent-status-types'
import type { AgentCompletionStatusSnapshot } from './agent-completion-coordinator-types'
import type { NotificationDispatchRequest } from '../../../../shared/types'

const LEAF = '11111111-1111-4111-8111-111111111111'
const PANE_KEY = `tab-1:${LEAF}`
const WORKTREE_ID = 'wt-primary'

type MockState = Record<string, unknown>
let mockState: MockState

vi.mock('@/store', () => ({
  useAppStore: { getState: () => mockState, subscribe: () => () => {} }
}))
vi.mock('@/lib/desktop-notification-sound', () => ({ playDesktopNotificationSound: vi.fn() }))

function baseState(): MockState {
  return {
    activeWorktreeId: 'wt-other',
    activeTabId: 'tab-1',
    tabsByWorktree: { [WORKTREE_ID]: [{ id: 'tab-1', ptyId: 'pty-1' }] },
    ptyIdsByTabId: { 'tab-1': ['pty-1'] },
    suppressedPtyExitIds: {},
    terminalLayoutsByTabId: {
      'tab-1': {
        root: { type: 'leaf', leafId: LEAF },
        activeLeafId: LEAF,
        expandedLeafId: null,
        ptyIdsByLeafId: { [LEAF]: 'pty-1' }
      }
    },
    browserTabsByWorktree: {},
    retainedAgentsByPaneKey: {},
    agentStatusByPaneKey: {} as Record<string, AgentStatusEntry>,
    worktreesByRepo: {
      repo1: [{ id: WORKTREE_ID, repoId: 'repo1', displayName: 'main', branch: 'main' }],
      repo2: [{ id: 'wt-other', repoId: 'repo2', displayName: 'other', branch: 'other' }]
    },
    repos: [
      { id: 'repo1', displayName: 'danmaku_monitor', connectionId: null },
      { id: 'repo2', displayName: 'second_repo', connectionId: null }
    ],
    settings: {
      experimentalTerminalAttention: false,
      notifications: { enabled: true, agentTaskComplete: true }
    },
    markWorktreeUnread: vi.fn(),
    markTerminalTabUnread: vi.fn(),
    markTerminalPaneUnread: vi.fn(),
    markAgentCompletionPaneUnread: vi.fn()
  }
}

function applyStatusToStore(payload: AgentCompletionStatusSnapshot, now: number): void {
  const store = mockState.agentStatusByPaneKey as Record<string, AgentStatusEntry>
  const previous = store[PANE_KEY]
  const stateStartedAt =
    previous && previous.state === payload.state ? previous.stateStartedAt : now
  store[PANE_KEY] = {
    ...previous,
    state: payload.state,
    prompt: payload.prompt,
    agentType: payload.agentType,
    toolName: payload.toolName,
    toolInput: payload.toolInput,
    lastAssistantMessage: payload.lastAssistantMessage,
    interrupted: payload.interrupted,
    subagents: payload.subagents,
    updatedAt: now,
    stateStartedAt,
    paneKey: PANE_KEY,
    terminalTitle: payload.agentType ?? 'agent',
    stateHistory: []
  } as AgentStatusEntry
}

function dispatchCalls(): NotificationDispatchRequest[] {
  const d = window.api.notifications.dispatch as unknown as ReturnType<typeof vi.fn>
  return d.mock.calls.map((c) => c[0] as NotificationDispatchRequest)
}

function makeCoordinator(): ReturnType<typeof createAgentCompletionCoordinator> {
  return createAgentCompletionCoordinator({
    paneKey: PANE_KEY,
    getPtyId: () => 'pty-1',
    getSettings: () => null,
    inspectProcess: async () => ({ foregroundProcess: null, hasChildProcesses: false }),
    dispatchCompletion: (title, meta) => {
      dispatchTerminalNotification(WORKTREE_ID, {
        source: 'agent-task-complete',
        terminalTitle: title,
        paneKey: PANE_KEY,
        ...(meta?.agentStatus ? { agentStatusSnapshot: meta.agentStatus } : {})
      })
    },
    dispatchAttention: (title, meta) => {
      dispatchTerminalNotification(WORKTREE_ID, {
        source: 'agent-task-complete',
        terminalTitle: title,
        paneKey: PANE_KEY,
        agentStatusSnapshot: meta.agentStatus
      })
    },
    isLive: () => true
  })
}

type Step = { ev: string; p?: Record<string, unknown>; waitMs?: number }

/** Drives real hook normalization -> store mirror -> coordinator -> dispatcher. */
function drive(source: AgentHookSource, steps: Step[]): NotificationDispatchRequest[] {
  const listenerState: HookListenerState = createHookListenerState()
  const coordinator = makeCoordinator()
  for (const step of steps) {
    const event = normalizeHookPayload(
      listenerState,
      source,
      {
        paneKey: PANE_KEY,
        tabId: 'tab-1',
        worktreeId: WORKTREE_ID,
        hook_event_name: step.ev,
        payload: { hook_event_name: step.ev, ...step.p }
      },
      'test-env'
    )
    if (event) {
      const now = Date.now()
      applyStatusToStore(event.payload, now)
      const stored = (mockState.agentStatusByPaneKey as Record<string, AgentStatusEntry>)[PANE_KEY]
      coordinator.observeHookStatus({ ...event.payload, stateStartedAt: stored.stateStartedAt })
    }
    vi.advanceTimersByTime(step.waitMs ?? 100)
  }
  vi.advanceTimersByTime(6_000)
  coordinator.dispose()
  return dispatchCalls()
}

const BASH_1 = { tool_name: 'Bash', tool_input: { command: 'npm run test:submit' } }
const BASH_2 = {
  tool_name: 'Bash',
  tool_input: { command: 'node scripts/check-hook-registry.js' }
}

describe('issue #4375 — non-turn-end notification spam', () => {
  beforeEach(() => {
    vi.useFakeTimers()
    vi.setSystemTime(new Date('2026-07-25T12:00:00Z'))
    vi.stubGlobal('document', { visibilityState: 'hidden', hasFocus: () => false })
    vi.stubGlobal('navigator', { userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64)' })
    vi.stubGlobal('window', {
      api: { notifications: { dispatch: vi.fn().mockResolvedValue({ delivered: true }) } }
    })
    mockState = baseState()
    // Why: completion identities are module-scoped and keyed by paneKey, so they leak between tests.
    resetAgentCompletionCoordinatorIdentitiesForTest()
  })
  afterEach(() => {
    vi.useRealTimers()
    vi.unstubAllGlobals()
  })

  it('control: a real turn end notifies once', () => {
    const calls = drive('codex', [
      { ev: 'UserPromptSubmit', p: { prompt: 'run tests' } },
      { ev: 'PreToolUse', p: BASH_1 },
      { ev: 'PostToolUse', p: BASH_1 },
      { ev: 'Stop' }
    ])
    expect(calls).toHaveLength(1)
    expect(calls[0].agentState).toBe('done')
  })

  it('REPRO: a Codex lead Stop notifies while a subagent is still working', () => {
    const calls = drive('codex', [
      { ev: 'UserPromptSubmit', p: { prompt: 'run tests' } },
      { ev: 'SubagentStart', p: { agent_id: 'child-1', agent_type: 'reviewer' } },
      { ev: 'PreToolUse', p: BASH_1 },
      // Lead finishes; the child keeps working well past the 1.5s quiet window.
      { ev: 'Stop', waitMs: 5_000 },
      { ev: 'PreToolUse', p: { ...BASH_2, agent_id: 'child-1' } }
    ])

    if (calls.length > 0) {
      throw new Error(
        `Spurious completion while subagent child-1 is still working: ` +
          `state=${calls[0].agentState} tool=${calls[0].agentToolInput}`
      )
    }
    expect(calls).toHaveLength(0)
  })

  it('cancels a mid-turn Stop when work resumes inside the quiet window', () => {
    const calls = drive('codex', [
      { ev: 'UserPromptSubmit', p: { prompt: 'run tests' } },
      { ev: 'PreToolUse', p: BASH_1 },
      // Resumes at 1s — inside HOOK_DONE_QUIET_MS, so the provisional done is cancelled.
      { ev: 'Stop', waitMs: 1_000 },
      { ev: 'PreToolUse', p: BASH_2 }
    ])
    expect(calls).toHaveLength(0)
  })

  it('a new session is not gated by the roster the previous Codex process left behind', () => {
    const listenerState: HookListenerState = createHookListenerState()
    const send = (
      ev: string,
      p?: Record<string, unknown>
    ): ReturnType<typeof normalizeHookPayload> =>
      normalizeHookPayload(
        listenerState,
        'codex',
        {
          paneKey: PANE_KEY,
          tabId: 'tab-1',
          worktreeId: WORKTREE_ID,
          hook_event_name: ev,
          payload: { hook_event_name: ev, ...p }
        },
        'test-env'
      )

    // A child parks in 'waiting', then the Codex process dies without a child Stop hook.
    send('UserPromptSubmit', { prompt: 'first' })
    send('PermissionRequest', { agent_id: 'child-1', agent_type: 'reviewer' })

    // Why: SessionStart retires the stale roster, so it must not also be gated by it.
    const restarted = send('SessionStart')
    expect(restarted?.payload.state).toBe('working')
  })

  it('gates notification without downgrading the reported state of a lead Stop', () => {
    // Why: an earlier cut of this fix gated by rewriting `state` to 'working', which silently
    // broke the sidebar/persistence contract that a root Stop retires child rows and reports
    // 'done' (server.test.ts). The suppression signal must ride alongside `done`, not replace it.
    const listenerState: HookListenerState = createHookListenerState()
    const send = (
      ev: string,
      p?: Record<string, unknown>
    ): ReturnType<typeof normalizeHookPayload> =>
      normalizeHookPayload(
        listenerState,
        'codex',
        {
          paneKey: PANE_KEY,
          tabId: 'tab-1',
          worktreeId: WORKTREE_ID,
          hook_event_name: ev,
          payload: { hook_event_name: ev, ...p }
        },
        'test-env'
      )

    send('UserPromptSubmit', { prompt: 'go' })
    send('SubagentStart', { agent_id: 'child-1', agent_type: 'reviewer' })

    const leadStop = send('Stop')
    expect(leadStop?.payload.state).toBe('done')
    expect(leadStop?.payload.subagents).toBeUndefined()
    expect(leadStop?.payload.leadStopWithLiveSubagents).toBe(true)

    // The child's own Stop is a real turn end: same shape, but no suppression flag.
    send('PreToolUse', { agent_id: 'child-1', tool_name: 'Bash', tool_input: { command: 'y' } })
    const childStop = send('SubagentStop', { agent_id: 'child-1' })
    expect(childStop?.payload.state).toBe('done')
    expect(childStop?.payload.leadStopWithLiveSubagents).toBeUndefined()
  })

  it('gates a lead Stop arriving over SSH/relay, which reconciles on a separate path', () => {
    // Why: remote panes never reach normalizeHookPayload's codex branch — the main process
    // re-derives their roster in reconcileRemoteCodexState, which does its own reap. Without the
    // same pre-reap capture there, the fix would cover local Codex only.
    const listenerState: HookListenerState = createHookListenerState()
    const remote = (
      ev: string,
      agentId: string | undefined,
      payload: Parameters<typeof reconcileRemoteCodexState>[4],
      previous?: Parameters<typeof reconcileRemoteCodexState>[5]
    ): ReturnType<typeof reconcileRemoteCodexState> =>
      reconcileRemoteCodexState(listenerState, PANE_KEY, ev, agentId, payload, previous)

    const working = { state: 'working', prompt: 'go', agentType: 'codex' } as const
    remote('UserPromptSubmit', undefined, { ...working })
    // The relay reports the live child roster alongside the lead's own state.
    remote('SubagentStart', 'child-1', {
      ...working,
      subagents: [{ id: 'child-1', state: 'working', agentType: 'reviewer', startedAt: Date.now() }]
    })

    const leadStop = remote('Stop', undefined, { state: 'done', prompt: 'go', agentType: 'codex' })
    expect(leadStop.state).toBe('done')
    expect(leadStop.subagents).toBeUndefined()
    expect(leadStop.leadStopWithLiveSubagents).toBe(true)
  })

  // KNOWN-OPEN residual, deliberately out of scope for the roster fix, and the reason this PR
  // does NOT close #4375: a bare mid-turn Stop (no subagent) that resumes AFTER the 1.5s quiet
  // window still notifies, which is the "notification after tool calls or reasoning" the issue
  // reports. There is no principled bound to widen the window to, and widening it delays every
  // real Codex completion; the correct fix is retracting the banner via notifications:dismiss on
  // the resuming 'working' hook, which needs a notification id plumbed back through
  // dispatchCompletion (currently `=> void`). Pinned here so that change flips this test.
  it('KNOWN-OPEN: a bare mid-turn Stop resuming after the quiet window still notifies', () => {
    const calls = drive('codex', [
      { ev: 'UserPromptSubmit', p: { prompt: 'run tests' } },
      { ev: 'PreToolUse', p: BASH_1 },
      { ev: 'Stop', waitMs: 2_000 },
      { ev: 'PreToolUse', p: BASH_2 }
    ])

    const finalRow = (mockState.agentStatusByPaneKey as Record<string, AgentStatusEntry>)[PANE_KEY]
    expect(finalRow.state).toBe('working')
    expect(calls).toHaveLength(1)
    // The banner carries the *previous* tool, matching the report in #4375.
    expect(calls[0].agentToolInput).toBe('npm run test:submit')
  })
})
