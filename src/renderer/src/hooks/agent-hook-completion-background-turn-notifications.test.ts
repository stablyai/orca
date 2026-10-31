import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { mkdtemp, mkdir, readFile, writeFile, appendFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { ClaudeHelperKillPoller } from '../../../shared/agent-hook-listener/providers/claude-helper-kill-poller'
import {
  createHookListenerState,
  seedLegacyAgentStatusForTests
} from '../../../shared/agent-hook-listener/listener-state'
import type { AgentHookEventPayload } from '../../../shared/agent-hook-listener/listener-event'
import { createTestStore, makeTab } from '../store/slices/store-test-helpers'
import { buildRunningAgentChildRowModels } from '../../../shared/running-agent-child-rows'
import { worktreeAgentChildRows } from '../../../../mobile/src/worktree/worktree-agent-child-rows'
import type { ParsedAgentStatusPayload } from '../../../shared/agent-status-types'
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
}

let mockStoreState: MockStoreState
let actualStore: ReturnType<typeof createTestStore> | undefined

vi.mock('@/store', () => ({
  useAppStore: {
    getState: () =>
      actualStore
        ? { ...actualStore.getState(), settings: mockStoreState.settings }
        : mockStoreState
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
    actualStore = undefined
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
      getAgentLaunchConfigForStatusEntry: () => undefined
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

  it('applies the provider retirement to visible rows and quit capture without announcing the parent twice', async () => {
    const { observeAgentHookCompletionForNotification } =
      await import('./agent-hook-completion-notifications')
    actualStore = createTestStore()
    const store = actualStore
    store.setState({
      tabsByWorktree: {
        [WORKTREE_ID]: [makeTab({ id: 'tab-1', worktreeId: WORKTREE_ID, ptyId: 'pty-1' })]
      },
      ptyIdsByTabId: { 'tab-1': ['pty-1'] },
      terminalLayoutsByTabId: {
        'tab-1': {
          root: { type: 'leaf', leafId: LEAF_ID },
          activeLeafId: LEAF_ID,
          expandedLeafId: null
        }
      }
    })
    const dir = await mkdtemp(join(tmpdir(), 'helper-consumers-'))
    const path = join(dir, 'session.jsonl')
    await mkdir(join(dir, 'session', 'subagents'), { recursive: true })
    const child = await readFile(
      new URL(
        '../../../shared/__fixtures__/claude-helper-kill-2.1.310-child.jsonl',
        import.meta.url
      ),
      'utf8'
    )
    const kill = { type: 'system', subtype: 'agents_killed', timestamp: '2026-10-29T11:38:18.695Z' }
    vi.setSystemTime(Date.parse(kill.timestamp) - 1_000)
    await writeFile(path, '')
    await writeFile(join(dir, 'session', 'subagents', 'agent-a123.jsonl'), child)
    const state = createHookListenerState()
    let current: AgentHookEventPayload | undefined
    const apply = (event: AgentHookEventPayload) => {
      current = event
      seedLegacyAgentStatusForTests(state, event)
      store.getState().setAgentStatus(
        PANE_KEY,
        event.payload,
        'Claude',
        {
          updatedAt: Date.now(),
          stateStartedAt: Date.now(),
          turnEndedAt: event.turnEndedAt,
          turnEndDisposition: event.turnEndDisposition
        },
        { tabId: 'tab-1', worktreeId: WORKTREE_ID },
        { providerSession: event.providerSession }
      )
      observeAgentHookCompletionForNotification({
        paneKey: PANE_KEY,
        worktreeId: WORKTREE_ID,
        payload: { ...event.payload, stateStartedAt: Date.now() }
      })
    }
    const poller = new ClaudeHelperKillPoller(state, {
      current: () => current,
      publish: apply,
      listening: () => true
    })
    try {
      for (const payload of [
        { hook_event_name: 'UserPromptSubmit', prompt: 'work' },
        { hook_event_name: 'SubagentStart', agent_id: 'a123' },
        {
          hook_event_name: 'Stop',
          last_assistant_message: 'READY',
          background_tasks: [{ id: 'a123', type: 'subagent', status: 'running' }]
        }
      ]) {
        const event = normalizeHookPayload(
          state,
          'claude',
          {
            paneKey: PANE_KEY,
            payload: { session_id: 'session', transcript_path: path, ...payload }
          },
          'production'
        )
        if (!event) {
          throw new Error('hook declined')
        }
        apply(event)
      }
      const before = store.getState().agentStatusByPaneKey[PANE_KEY]!
      const beforeEvent = current!
      expect(beforeEvent.payload.turnCompletedAt).toBe(Date.parse(kill.timestamp) - 1_000)
      expect(before.turnEndedAt).toBeUndefined()
      expect(before.turnEndDisposition).toBeUndefined()
      expect(before.subagents?.[0]?.id).toBe('a123')
      poller.schedule(current!)
      vi.advanceTimersByTime(HOOK_DONE_QUIET_MS)
      await poller.poll(PANE_KEY)
      expect(dispatchTerminalNotification).toHaveBeenCalledTimes(1)
      await appendFile(path, `${JSON.stringify(kill)}\n`)
      await poller.poll(PANE_KEY)
      vi.advanceTimersByTime(HOOK_DONE_QUIET_MS)
      const after = store.getState().agentStatusByPaneKey[PANE_KEY]!
      expect(after.state).toBe('done')
      expect(after.subagents ?? []).toEqual([])
      expect(after.mainAgent).toEqual(before.mainAgent)
      expect(current?.hookEventName).toBe('SubagentStop')
      expect(current?.toolAgentId).toBe('a123')
      expect(current?.payload.turnCompletedAt).toBe(beforeEvent.payload.turnCompletedAt)
      expect(after.turnEndedAt).toBeUndefined()
      expect(after.turnEndDisposition).toBeUndefined()
      expect(dispatchTerminalNotification).toHaveBeenCalledTimes(1)
      expect(
        buildRunningAgentChildRowModels(after, {
          parentEvidenceFresh: true,
          transportObservation: 'live',
          parentObservedAt: after.updatedAt,
          hostClockOffsetMs: 0
        })
      ).toEqual([])
      expect(
        worktreeAgentChildRows(
          {
            paneKey: PANE_KEY,
            parentPaneKey: null,
            state: after.state,
            agentType: 'claude',
            prompt: after.prompt,
            taskTitle: null,
            displayName: null,
            lastAssistantMessage: after.lastAssistantMessage ?? null,
            toolName: null,
            toolInput: null,
            interrupted: false,
            stateStartedAt: after.stateStartedAt,
            updatedAt: after.updatedAt,
            subagents: after.subagents,
            subagentObservation: 'live'
          },
          true
        )
      ).toEqual([])
      store.getState().captureAllSleepingAgentSessions('quit')
      expect(store.getState().sleepingAgentSessionsByPaneKey[PANE_KEY]).toMatchObject({
        origin: 'live',
        providerSession: { id: 'session', transcriptPath: path }
      })
    } finally {
      poller.clearAll()
      await rm(dir, { recursive: true, force: true })
      actualStore = undefined
    }
  })
})
