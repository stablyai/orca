import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { ParsedAgentStatusPayload } from '../../../shared/agent-status-types'
import { createHookListenerState } from '../../../shared/agent-hook-listener/listener-state'
import { normalizeHookPayload } from '../../../shared/agent-hook-listener'
import { makePaneKey } from '../../../shared/stable-pane-id'

const dispatchTerminalNotification = vi.fn()
const dispatchAgentHookTerminalLifecycle = vi.fn()

const HOOK_DONE_QUIET_MS = 1_500
const LEAF_ID = '11111111-1111-4111-8111-111111111111'
const PANE_KEY = makePaneKey('tab-1', LEAF_ID)
const WORKTREE_ID = 'wt-1'

type MockStoreState = {
  settings: {
    experimentalTerminalAttention?: boolean
    notifications: {
      enabled: boolean
      agentTaskComplete: boolean
    }
  }
  ptyIdsByTabId: Record<string, string[]>
  suppressedPtyExitIds: Record<string, boolean>
  tabsByWorktree: Record<string, { id: string; ptyId?: string | null }[]>
  terminalLayoutsByTabId: Record<string, unknown>
  agentLaunchConfigByPaneKey: Record<string, unknown>
  agentStatusByPaneKey: Record<string, unknown>
  getAgentLaunchConfigForStatusEntry: () => undefined
  getAgentLaunchConfigForStatusMetadata: () => undefined
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

type HookRow = ParsedAgentStatusPayload & { stateStartedAt: number }

function pinStateStartedAt(
  previous: HookRow | undefined,
  payload: ParsedAgentStatusPayload,
  now: number
): HookRow {
  return {
    ...payload,
    stateStartedAt: previous && previous.state === payload.state ? previous.stateStartedAt : now
  }
}

describe('Claude background-turn completion notifications', () => {
  beforeEach(() => {
    vi.resetModules()
    vi.useFakeTimers()
    vi.setSystemTime(1_700_000_000_000)
    dispatchTerminalNotification.mockClear()
    dispatchAgentHookTerminalLifecycle.mockClear()
    mockStoreState = {
      settings: {
        experimentalTerminalAttention: false,
        notifications: {
          enabled: true,
          agentTaskComplete: true
        }
      },
      ptyIdsByTabId: {
        'tab-1': ['pty-1']
      },
      suppressedPtyExitIds: {},
      tabsByWorktree: {
        [WORKTREE_ID]: [{ id: 'tab-1', ptyId: 'pty-1' }]
      },
      terminalLayoutsByTabId: {},
      agentLaunchConfigByPaneKey: {},
      agentStatusByPaneKey: {},
      getAgentLaunchConfigForStatusEntry: () => undefined,
      getAgentLaunchConfigForStatusMetadata: () => undefined
    }
  })

  afterEach(() => {
    vi.useRealTimers()
  })

  async function play(events: { at: number; payload: Record<string, unknown> }[]): Promise<{
    banners: { at: number; body: string | undefined; stateStartedAt: number | undefined }[]
    rows: HookRow[]
  }> {
    const { observeAgentHookCompletionForNotification } =
      await import('./agent-hook-completion-notifications')
    const listener = createHookListenerState()
    const rows: HookRow[] = []
    let previous: HookRow | undefined
    const banners: {
      at: number
      body: string | undefined
      stateStartedAt: number | undefined
    }[] = []

    dispatchTerminalNotification.mockImplementation((_worktreeId, event) => {
      banners.push({
        at: Date.now(),
        body: event.agentStatusSnapshot?.lastAssistantMessage,
        stateStartedAt: event.agentStatusSnapshot?.stateStartedAt
      })
    })

    for (const event of events) {
      vi.setSystemTime(event.at)
      const normalized = normalizeHookPayload(
        listener,
        'claude',
        { paneKey: PANE_KEY, payload: event.payload },
        'production'
      )
      if (!normalized) {
        continue
      }
      const row = pinStateStartedAt(previous, normalized.payload, event.at)
      previous = row
      rows.push(row)
      observeAgentHookCompletionForNotification({
        paneKey: PANE_KEY,
        worktreeId: WORKTREE_ID,
        payload: row
      })
      vi.advanceTimersByTime(HOOK_DONE_QUIET_MS)
    }

    return { banners, rows }
  }

  it('announces a subagent turn at Stop with that turn’s text, not when the child later drains', async () => {
    const { banners, rows } = await play([
      {
        at: 1_700_000_000_000,
        payload: { hook_event_name: 'UserPromptSubmit', prompt: 'review the PR' }
      },
      {
        at: 1_700_000_001_000,
        payload: {
          hook_event_name: 'SubagentStart',
          agent_id: 'a1',
          agent_type: 'general-purpose'
        }
      },
      {
        at: 1_700_000_006_000,
        payload: {
          hook_event_name: 'Stop',
          last_assistant_message: 'Which cells need hand-verification?',
          background_tasks: [{ id: 'a1', type: 'subagent', status: 'running' }]
        }
      },
      {
        at: 1_700_000_055_000,
        payload: { hook_event_name: 'SubagentStop', agent_id: 'a1' }
      }
    ])

    const stop = rows.find((row) => row.lastAssistantMessage?.includes('hand-verification'))
    expect(stop?.state).toBe('working')
    expect(stop?.turnCompletedAt).toBe(1_700_000_006_000)
    expect(banners).toHaveLength(1)
    expect(banners[0]?.at).toBe(1_700_000_006_000)
    expect(banners[0]?.body).toBe('Which cells need hand-verification?')
    expect(banners[0]?.stateStartedAt).toBe(1_700_000_006_000)
  })

  it('notifies each background-shell turn with a distinct notification identity', async () => {
    const { banners } = await play([
      {
        at: 1_700_000_000_000,
        payload: { hook_event_name: 'UserPromptSubmit', prompt: 'start the server' }
      },
      {
        at: 1_700_000_001_000,
        payload: {
          hook_event_name: 'Stop',
          last_assistant_message: 'Dev server is up.',
          background_tasks: [{ id: 'shell-1', type: 'shell', status: 'running' }]
        }
      },
      {
        at: 1_700_000_010_000,
        payload: { hook_event_name: 'UserPromptSubmit', prompt: 'add a route' }
      },
      {
        at: 1_700_000_011_000,
        payload: {
          hook_event_name: 'Stop',
          last_assistant_message: 'Route added.',
          background_tasks: [{ id: 'shell-1', type: 'shell', status: 'running' }]
        }
      }
    ])

    expect(banners).toHaveLength(2)
    expect(banners[0]).toMatchObject({
      at: 1_700_000_001_000,
      body: 'Dev server is up.',
      stateStartedAt: 1_700_000_001_000
    })
    expect(banners[1]).toMatchObject({
      at: 1_700_000_011_000,
      body: 'Route added.',
      stateStartedAt: 1_700_000_011_000
    })
    expect(banners[0]?.stateStartedAt).not.toBe(banners[1]?.stateStartedAt)
  })

  it('notifies every turn under a persistent session cron with distinct ids', async () => {
    const cron = [{ id: 'cron-1' }]
    const { banners } = await play([
      {
        at: 1_700_000_000_000,
        payload: { hook_event_name: 'UserPromptSubmit', prompt: 'first' }
      },
      {
        at: 1_700_000_001_000,
        payload: {
          hook_event_name: 'Stop',
          last_assistant_message: 'First done.',
          session_crons: cron
        }
      },
      {
        at: 1_700_000_002_000,
        payload: { hook_event_name: 'UserPromptSubmit', prompt: 'second' }
      },
      {
        at: 1_700_000_003_000,
        payload: {
          hook_event_name: 'Stop',
          last_assistant_message: 'Second done.',
          session_crons: cron
        }
      },
      {
        at: 1_700_000_004_000,
        payload: { hook_event_name: 'UserPromptSubmit', prompt: 'third' }
      },
      {
        at: 1_700_000_005_000,
        payload: {
          hook_event_name: 'Stop',
          last_assistant_message: 'Third done.',
          session_crons: cron
        }
      }
    ])

    expect(banners.map((banner) => banner.body)).toEqual([
      'First done.',
      'Second done.',
      'Third done.'
    ])
    expect(new Set(banners.map((banner) => banner.stateStartedAt)).size).toBe(3)
  })
})
