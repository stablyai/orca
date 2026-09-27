import { readFileSync } from 'node:fs'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type {
  AgentStatusIpcPayload,
  ParsedAgentStatusPayload
} from '../../../shared/agent-status-types'
import { normalizeHookPayload } from '../../../shared/agent-hook-listener'
import { createHookListenerState } from '../../../shared/agent-hook-listener/listener-state'
import { makePaneKey } from '../../../shared/stable-pane-id'
import { normalizeAgentStatusEvent } from './ipc-events/normalize-agent-status-event'

const dispatchTerminalNotification = vi.fn()
const dispatchAgentHookTerminalLifecycle = vi.fn()
const LEAF_ID = '11111111-1111-4111-8111-111111111111'
const PANE_KEY = makePaneKey('tab-1', LEAF_ID)
const WORKTREE_ID = 'wt-1'
const capturedHooks = readFileSync(
  new URL('../../../shared/__fixtures__/grok-background-completion-hooks.jsonl', import.meta.url),
  'utf8'
)
  .trim()
  .split('\n')
  .map(parseCapturedHook)

function parseCapturedHook(line: string): Record<string, unknown> {
  // JSON.parse returns any; the runtime guard below is what actually proves the shape.
  const parsed: Record<string, unknown> = JSON.parse(line)
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
    throw new Error('Captured Grok hook must be an object')
  }
  return parsed
}

type MockStoreState = {
  settings: {
    experimentalTerminalAttention?: boolean
    notifications: { enabled: boolean; agentTaskComplete: boolean }
  }
  ptyIdsByTabId: Record<string, string[]>
  suppressedPtyExitIds: Record<string, boolean>
  tabsByWorktree: Record<string, { id: string; ptyId?: string | null }[]>
  terminalLayoutsByTabId: Record<string, unknown>
  agentLaunchConfigByPaneKey: Record<string, unknown>
  agentStatusByPaneKey: Record<string, unknown>
  getAgentLaunchConfigForStatusEntry: () => undefined
}

let mockStoreState: MockStoreState

vi.mock('@/store', () => ({ useAppStore: { getState: () => mockStoreState } }))
vi.mock('@/components/terminal-pane/use-notification-dispatch', () => ({
  dispatchTerminalNotification
}))
vi.mock('@/components/terminal-pane/agent-hook-terminal-lifecycle', () => ({
  dispatchAgentHookTerminalLifecycle
}))

type PlayedNotification = {
  at: number
  snapshot?: ParsedAgentStatusPayload & { stateStartedAt?: number }
}

describe('Grok hook completion notifications', () => {
  beforeEach(() => {
    vi.resetModules()
    vi.useFakeTimers()
    dispatchTerminalNotification.mockReset()
    dispatchAgentHookTerminalLifecycle.mockReset()
    mockStoreState = {
      settings: {
        experimentalTerminalAttention: false,
        notifications: { enabled: true, agentTaskComplete: true }
      },
      ptyIdsByTabId: { 'tab-1': ['pty-1'] },
      suppressedPtyExitIds: {},
      tabsByWorktree: { [WORKTREE_ID]: [{ id: 'tab-1', ptyId: 'pty-1' }] },
      terminalLayoutsByTabId: {},
      agentLaunchConfigByPaneKey: {},
      agentStatusByPaneKey: {},
      getAgentLaunchConfigForStatusEntry: () => undefined
    }
  })

  afterEach(() => {
    vi.useRealTimers()
  })

  async function play(hooks: readonly Record<string, unknown>[]): Promise<PlayedNotification[]> {
    const { observeAgentHookCompletionForNotification } =
      await import('./agent-hook-completion-notifications')
    const listener = createHookListenerState()
    const notifications: PlayedNotification[] = []
    let previousState: ParsedAgentStatusPayload['state'] | undefined
    let stateStartedAt = 0

    dispatchTerminalNotification.mockImplementation((_worktreeId, event) => {
      notifications.push({ at: Date.now(), snapshot: event.agentStatusSnapshot })
    })

    for (const hook of hooks) {
      const at = Date.parse(String(hook.timestamp))
      vi.setSystemTime(at)
      const event = normalizeHookPayload(
        listener,
        'grok',
        { paneKey: PANE_KEY, payload: hook },
        'production'
      )
      if (!event) {
        continue
      }
      if (event.payload.state !== previousState) {
        stateStartedAt = at
      }
      previousState = event.payload.state
      const ipcPayload: AgentStatusIpcPayload = {
        ...event.payload,
        paneKey: PANE_KEY,
        connectionId: null,
        receivedAt: at,
        stateStartedAt
      }
      const rendererPayload = normalizeAgentStatusEvent(ipcPayload)
      if (!rendererPayload) {
        throw new Error('Expected renderer status payload')
      }
      observeAgentHookCompletionForNotification({
        paneKey: PANE_KEY,
        worktreeId: WORKTREE_ID,
        payload: { ...rendererPayload, stateStartedAt }
      })
    }

    return notifications
  }

  it('replays the captured two-turn request into exactly one final announcement', async () => {
    const notifications = await play(capturedHooks.slice(0, 8))
    vi.advanceTimersByTime(1_500)

    expect(notifications).toHaveLength(1)
    expect(notifications[0]).toMatchObject({
      at: Date.parse('2026-09-12T02:42:44.033962+00:00'),
      snapshot: {
        state: 'done',
        agentType: 'grok',
        lastAssistantMessage: 'The background command finished successfully.',
        stateStartedAt: Date.parse('2026-09-12T02:42:42.533962+00:00')
      }
    })
  })

  it('keeps the captured SessionEnd and shutdown Stop tail silent', async () => {
    const shutdownTail = capturedHooks.filter(
      (hook) => hook.reason === 'shutdown' || hook.hookEventName === 'session_end'
    )

    expect(await play(shutdownTail)).toHaveLength(0)
  })

  it.each([
    {
      eventName: 'StopFailure',
      interrupted: undefined,
      payload: {
        error: 'server_error',
        errorDetails: 'upstream failed',
        lastAssistantMessage: 'The request failed.'
      }
    },
    {
      eventName: 'StopCancelled',
      interrupted: true,
      payload: {
        reason: 'user_interrupt',
        cancelledBy: 'user',
        cancelTrigger: 'stop_gesture',
        reasonDetails: 'user interrupted the turn',
        lastAssistantMessage: 'Stopped by user.'
      }
    }
  ])('announces real-shaped $eventName payloads', async (scenario) => {
    const notifications = await play([
      {
        hookEventName: 'UserPromptSubmit',
        timestamp: '2026-09-12T03:00:00.000Z',
        sessionId: 'session-1',
        promptId: 'prompt-1',
        prompt: 'finish the request'
      },
      {
        hookEventName: scenario.eventName,
        timestamp: '2026-09-12T03:00:01.000Z',
        sessionId: 'session-1',
        promptId: 'prompt-1',
        ...scenario.payload
      }
    ])
    vi.advanceTimersByTime(1_500)

    expect(notifications).toHaveLength(1)
    expect(notifications[0]?.snapshot).toMatchObject({
      state: 'done',
      ...(scenario.interrupted ? { interrupted: true } : {})
    })
  })

  // Pins grok-events.ts finite-task allowlist; broadening it to monitors or sessionCrons must redden.
  it.each([
    {
      label: 'monitor',
      backgroundTasks: [
        { id: 'monitor-1', type: 'monitor', status: 'running', description: 'watch the build' }
      ],
      sessionCrons: []
    },
    {
      label: 'cron',
      backgroundTasks: [],
      sessionCrons: [
        { id: 'cron-1', schedule: 'every minute', recurring: true, prompt: 'check the build' }
      ]
    }
  ])('announces with only a running $label outstanding', async (scenario) => {
    const notifications = await play([
      {
        hookEventName: 'UserPromptSubmit',
        timestamp: '2026-09-12T03:01:00.000Z',
        prompt: 'finish the request'
      },
      {
        hookEventName: 'Stop',
        timestamp: '2026-09-12T03:01:01.000Z',
        reason: 'end_turn',
        stopHookActive: false,
        backgroundTasks: scenario.backgroundTasks,
        sessionCrons: scenario.sessionCrons
      }
    ])
    vi.advanceTimersByTime(1_500)

    expect(notifications).toHaveLength(1)
  })

  it('stays silent while a background subagent outlives the main agent, then announces once', async () => {
    const turn = (timestamp: string, promptId: string, backgroundTasks: unknown[]) => [
      { hookEventName: 'UserPromptSubmit', timestamp, sessionId: 'session-1', promptId },
      {
        hookEventName: 'Stop',
        timestamp: timestamp.replace(':00.000Z', ':01.000Z'),
        sessionId: 'session-1',
        promptId,
        reason: 'end_turn',
        stopHookActive: false,
        backgroundTasks
      }
    ]
    const early = await play(
      turn('2026-09-12T03:05:00.000Z', 'prompt-1', [
        { id: 'task-1', type: 'subagent', status: 'running', agentType: 'general-purpose' }
      ])
    )
    vi.advanceTimersByTime(1_500)
    expect(early).toHaveLength(0)

    const notifications = await play([
      ...turn('2026-09-12T03:06:00.000Z', 'prompt-1', [
        { id: 'task-1', type: 'subagent', status: 'running', agentType: 'general-purpose' }
      ]),
      ...turn('2026-09-12T03:07:00.000Z', 'task-completed-task-1', [])
    ])
    vi.advanceTimersByTime(1_500)
    expect(notifications).toHaveLength(1)
    expect(notifications[0]).toMatchObject({
      at: Date.parse('2026-09-12T03:07:02.500Z'),
      snapshot: { state: 'done', agentType: 'grok' }
    })
  })

  it('does not announce a delayed cancellation after the next prompt starts', async () => {
    const notifications = await play([
      {
        hookEventName: 'UserPromptSubmit',
        timestamp: '2026-09-12T03:02:00.000Z',
        sessionId: 'session-1',
        promptId: 'prompt-old',
        prompt: 'old turn'
      },
      {
        hookEventName: 'UserPromptSubmit',
        timestamp: '2026-09-12T03:02:01.000Z',
        sessionId: 'session-1',
        promptId: 'prompt-new',
        prompt: 'new turn'
      },
      {
        hookEventName: 'StopCancelled',
        timestamp: '2026-09-12T03:02:02.000Z',
        sessionId: 'session-1',
        promptId: 'prompt-old',
        reason: 'user_interrupt'
      }
    ])
    vi.advanceTimersByTime(1_500)

    expect(notifications).toHaveLength(0)
  })

  it('announces once from idle_prompt after repeated continuation Stops', async () => {
    const notifications = await play([
      {
        hookEventName: 'UserPromptSubmit',
        timestamp: '2026-09-12T03:03:00.000Z',
        sessionId: 'session-1',
        promptId: 'prompt-1',
        prompt: 'run the verification gate'
      },
      ...['2026-09-12T03:03:01.000Z', '2026-09-12T03:03:02.000Z'].map((timestamp) => ({
        hookEventName: 'Stop',
        timestamp,
        sessionId: 'session-1',
        promptId: 'prompt-1',
        reason: 'end_turn',
        stopHookActive: true,
        backgroundTasks: []
      })),
      {
        hookEventName: 'Notification',
        timestamp: '2026-09-12T03:04:02.000Z',
        sessionId: 'session-1',
        notificationType: 'idle_prompt',
        message: 'Waiting for your next prompt'
      }
    ])

    expect(notifications).toHaveLength(0)
    vi.advanceTimersByTime(1_500)
    expect(notifications).toHaveLength(1)
  })
})
