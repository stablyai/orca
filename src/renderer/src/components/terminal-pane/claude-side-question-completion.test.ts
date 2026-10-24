import { bindPtyConnectionTestMocks } from './pty-connection-mocks.spec'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { makePaneKey } from '../../../../shared/stable-pane-id'
import { flushAsyncTicks } from './pty-connection-test-async'
import {
  LEAF_1,
  createMockTransport,
  createPane,
  createManager,
  type MockTransport
} from './pty-connection-test-pane-fixtures'
import { buildPaneConnectionDeps } from './pty-connection-test-deps'
import { connectMockPanePty } from './pty-connection-test-connect-mock-pane'
import { createInitialStoreState } from './pty-connection-test-store-fixtures'
import type { StoreState } from './pty-connection-test-store-state'
import type { AgentCompletionStatusSnapshot } from './agent-completion-coordinator-types'
import type { NotificationDispatchRequest } from '../../../../shared/notification-settings-types'
import { reserveNotificationCooldown } from '../../../../shared/notification-burst-cooldown'
import { reduceHostTurnEnd } from '../../../../shared/agent-hook-turn-end-timing'
import { pickHostTurnEnd } from '../../../../shared/agent-status-types'
import type { AgentHookEventPayload } from '../../../../shared/agent-hook-listener/listener-event'
import {
  installTerminalTestGlobals,
  restoreTerminalTestGlobals
} from './pty-connection-test-environment'

const PANE_KEY = makePaneKey('tab-1', LEAF_1)
const SEA = "The sea's waves carry the endless rhythm of tides."

type TimelineEvent =
  | { at: number; title: string; bell?: true }
  | { at: number; bell: true }
  | { at: number; foreground: string | null }
  | { at: number; hook: HookName; message?: string; flagged?: true }

type HookName = 'UserPromptSubmit' | 'PreToolUse' | 'Stop' | 'Notification'

// Recorded from Claude Code 2.1.280 over a real PTY (ms from launch): one prompt, then a
// `/btw` side question 45 s later. The side question spins the title and fires no hook.
// The BEL beside each idle title is the burst agents commonly emit at a turn end; the one 600 ms
// after the side question's idle title stands in for Codex /compact's (QA F5b).
const SIDE_QUESTION: TimelineEvent[] = [
  { at: 0, title: '✳ Claude Code' },
  { at: 3_416, hook: 'UserPromptSubmit' },
  { at: 3_686, title: '◐ Claude Code' },
  { at: 4_647, title: '◑ Claude Code' },
  { at: 7_050, title: '◑ The sea' },
  { at: 7_552, title: '◐ The sea' },
  { at: 8_447, hook: 'Stop', message: SEA },
  { at: 8_760, title: '✳ The sea', bell: true },
  { at: 53_328, title: '◑ The sea' },
  { at: 54_299, title: '◐ The sea' },
  { at: 55_146, title: '✳ The sea' },
  { at: 55_746, bell: true },
  // Added: a title spin as the agent quits, with no idle edge before it exits (QA Q2, Codex /quit).
  { at: 60_000, title: '◐ The sea' },
  // Added: goose (no hooks, no idle title) replaces Claude in the pane, works, and exits.
  { at: 62_000, foreground: 'goose' },
  { at: 80_000, title: '◐ Working' },
  { at: 90_000, foreground: null }
]

// A Stop hook that blocks twice: Stop #1's banner goes out at 6.5 s, Claude continues text-only and
// re-enters Stop with the same text, then again with the final text 3 s after that banner, both
// inside main's 5 s cooldown. A minute on an idle reminder restates the turn. Then a second turn
// whose re-entered Stop is overtaken by the user's next prompt before its cooldown passes.
const BLOCKED_STOP: TimelineEvent[] = [
  { at: 0, title: '✳ Claude Code' },
  { at: 1_000, hook: 'UserPromptSubmit' },
  { at: 1_200, title: '◐ Claude Code' },
  { at: 5_000, hook: 'Stop', message: 'Draft answer.' },
  { at: 6_000, title: '◑ Claude Code' },
  { at: 8_000, hook: 'Stop', message: 'Draft answer.', flagged: true },
  { at: 9_500, hook: 'Stop', message: 'Final answer.', flagged: true },
  { at: 9_590, title: '✳ Claude Code' },
  { at: 72_000, hook: 'Notification' },
  { at: 80_000, hook: 'UserPromptSubmit' },
  { at: 85_000, hook: 'Stop', message: 'Second turn.' },
  { at: 87_000, hook: 'Stop', message: 'Second turn, revised.', flagged: true },
  { at: 88_000, hook: 'UserPromptSubmit' },
  { at: 93_000, hook: 'Stop', message: 'Third turn.' }
]

// Prompt hooks the host never received (a POST past its 1.5 s limit). Each such end is ambiguous,
// so the pane keeps main's banners whichever of the title and the hook comes first; a verified
// tool-using continuation still gets its final banner, and a later unflagged repeat stays quiet.
const LOST_OPENINGS: TimelineEvent[] = [
  { at: 0, title: '✳ Claude Code' },
  { at: 1_000, hook: 'UserPromptSubmit' },
  { at: 1_200, title: '◐ Claude Code' },
  { at: 5_000, hook: 'Stop', message: 'First.' },
  { at: 5_300, title: '✳ Claude Code' },
  // Text-only, the idle title before the Stop.
  { at: 20_000, title: '◐ Claude Code' },
  { at: 24_000, title: '✳ Claude Code' },
  { at: 24_800, hook: 'Stop', message: 'Second.' },
  { at: 40_000, hook: 'UserPromptSubmit' },
  { at: 40_200, title: '◐ Claude Code' },
  { at: 44_000, hook: 'Stop', message: 'Draft.' },
  { at: 46_000, hook: 'PreToolUse' },
  { at: 52_000, hook: 'Stop', message: 'Final.', flagged: true },
  { at: 52_300, title: '✳ Claude Code' },
  // Text-only, the working title before the missing prompt hook.
  { at: 70_000, title: '◐ Claude Code' },
  { at: 74_000, hook: 'Stop', message: 'Third.' },
  { at: 74_300, title: '✳ Claude Code' },
  // Tool-using, the working title first.
  { at: 90_000, title: '◐ Claude Code' },
  { at: 90_500, hook: 'PreToolUse' },
  { at: 95_000, hook: 'Stop', message: 'Fourth.' },
  { at: 95_300, title: '✳ Claude Code' },
  { at: 110_000, hook: 'Stop', message: 'Fourth.' }
]

describe('Claude completion banners through the real pane and hook lanes', () => {
  let mockStoreState: StoreState
  let transportQueue: MockTransport[] = []
  let transportOptions: Record<string, unknown>[] = []
  let storeSubscribers: ((state: StoreState) => void)[] = []
  let foreground: string | null = 'claude'
  let banners: NotificationDispatchRequest[] = []

  beforeEach(async () => {
    vi.resetModules()
    vi.clearAllMocks()
    transportQueue = []
    transportOptions = []
    storeSubscribers = []
    foreground = 'claude'
    mockStoreState = createInitialStoreState(() => mockStoreState)
    bindPtyConnectionTestMocks({
      getState: () => mockStoreState,
      getTransportQueue: () => transportQueue,
      getTransportOptions: () => transportOptions,
      getStoreSubscribers: () => storeSubscribers,
      setStoreSubscribers: (subscribers) => {
        storeSubscribers = subscribers
      }
    })
    await installTerminalTestGlobals()
    vi.useFakeTimers()
    vi.mocked(window.api.pty.getForegroundProcess).mockImplementation(async () => foreground)
    vi.mocked(window.api.pty.hasChildProcesses).mockImplementation(async () => foreground !== null)
    // Main's desktop cooldown, keyed as main's delivery service keys it, decides what the user sees.
    banners = []
    const recentDesktop = new Map<string, number>()
    vi.mocked(window.api.notifications.dispatch).mockImplementation(async (request) => {
      const key = request.attentionKey ?? request.worktreeId ?? 'global'
      if (!reserveNotificationCooldown(recentDesktop, key, Date.now())) {
        return { delivered: false, reason: 'cooldown' }
      }
      banners.push(request)
      return { delivered: true }
    })
  })

  afterEach(async () => {
    await restoreTerminalTestGlobals()
  })

  async function play(timeline: TimelineEvent[], servedBy?: string): Promise<void> {
    const { dispatchTerminalNotification } = await import('./use-notification-dispatch')
    const { observeAgentHookCompletionForNotification } =
      await import('@/hooks/agent-hook-completion-notifications')
    const transport = createMockTransport('tab-pty')
    transport.connect.mockImplementation(async () => null)
    transportQueue.push(transport)
    const deps = buildPaneConnectionDeps(() => mockStoreState, {
      restoredLeafId: LEAF_1,
      restoredPtyIdByLeafId: { [LEAF_1]: 'tab-pty' },
      dispatchNotification: (event: Parameters<typeof dispatchTerminalNotification>[1]) =>
        dispatchTerminalNotification('wt-1', event)
    })
    await connectMockPanePty(createPane(1), createManager(1), deps)
    await vi.advanceTimersByTimeAsync(20)
    await flushAsyncTicks(20)
    if (servedBy) {
      // A pane of a paired server that predates the turn-end stamp (it advertises no capability).
      const ptyId = `remote:${servedBy}@@pty-1`
      const layout = mockStoreState.terminalLayoutsByTabId?.['tab-1']
      if (!layout) {
        throw new Error('Expected the pane layout')
      }
      vi.mocked(transport.getPtyId).mockReturnValue(ptyId)
      mockStoreState.ptyIdsByTabId = { 'tab-1': [ptyId] }
      mockStoreState.terminalLayoutsByTabId = {
        'tab-1': { ...layout, ptyIdsByLeafId: { [LEAF_1]: ptyId } }
      }
      mockStoreState.runtimeStatusByEnvironmentId.set(servedBy, {
        checkedAt: Date.now(),
        status: { capabilities: [] }
      })
    }

    // Stand in for the transport's title tracker: every title, plus its working/idle edge.
    const transportHandler = (name: string) => {
      const handler: unknown = transportOptions[0]?.[name]
      if (typeof handler !== 'function') {
        throw new Error(`Expected the pane to register ${name}`)
      }
      return handler
    }
    let working = false
    let elapsed = 0
    let hostRow: (AgentHookEventPayload & { stateStartedAt?: number }) | undefined
    for (const event of timeline) {
      await vi.advanceTimersByTimeAsync(event.at - elapsed)
      elapsed = event.at
      if ('foreground' in event) {
        foreground = event.foreground
        continue
      }
      if (!('title' in event) && 'bell' in event) {
        transportHandler('onBell')()
        continue
      }
      if ('title' in event) {
        transportHandler('onTitleChange')(event.title, event.title)
        const nowWorking = !event.title.startsWith('✳')
        if (nowWorking !== working) {
          transportHandler(nowWorking ? 'onAgentBecameWorking' : 'onAgentBecameIdle')(event.title)
        }
        working = nowWorking
        if (event.bell) {
          transportHandler('onBell')()
        }
        continue
      }
      // The host's own derivation: its state clock, end stamp and disposition.
      const hookEvent: AgentHookEventPayload = {
        paneKey: PANE_KEY,
        connectionId: null,
        source: 'claude',
        hookEventName: event.hook,
        ...(event.flagged ? { stopHookActive: true } : {}),
        payload: {
          state: event.hook === 'Stop' || event.hook === 'Notification' ? 'done' : 'working',
          prompt: 'Reply with one short sentence.',
          agentType: 'claude',
          ...(event.message ? { lastAssistantMessage: event.message } : {})
        }
      }
      const stateStartedAt =
        hostRow?.payload.state === hookEvent.payload.state ? hostRow.stateStartedAt : Date.now()
      hostRow = { ...hookEvent, ...reduceHostTurnEnd(hostRow, hookEvent, Date.now(), true) }
      hostRow.stateStartedAt = stateStartedAt
      const payload: AgentCompletionStatusSnapshot = {
        ...hookEvent.payload,
        stateStartedAt,
        ...pickHostTurnEnd(hostRow)
      }
      mockStoreState.agentStatusByPaneKey[PANE_KEY] = {
        ...payload,
        paneKey: PANE_KEY,
        updatedAt: Date.now(),
        stateHistory: []
      }
      observeAgentHookCompletionForNotification({ paneKey: PANE_KEY, worktreeId: 'wt-1', payload })
    }
    await vi.advanceTimersByTimeAsync(5_000)
  }

  const rich = (message: string) =>
    expect.objectContaining({ source: 'agent-task-complete', agentLastAssistantMessage: message })

  it('announces the turn once; a /btw, its late BEL and quitting stay quiet, a hookless successor does not', async () => {
    await play(SIDE_QUESTION)
    // Claude is replaced in the pane by goose (no hooks), which later exits.
    foreground = 'goose'
    await vi.advanceTimersByTimeAsync(15_000)
    foreground = null
    await vi.advanceTimersByTimeAsync(15_000)

    expect(banners).toEqual([
      expect.objectContaining({ agentType: 'claude', agentLastAssistantMessage: SEA }),
      expect.objectContaining({ source: 'agent-task-complete', terminalTitle: 'goose' })
    ])
  })

  it("keeps main's banners for a /btw on a pane whose paired server predates the stamp", async () => {
    await play(SIDE_QUESTION, 'old-server')

    // The hook banner wins the burst; the /btw gets main's generic title banner, which absorbs its BEL.
    expect(banners).toEqual([
      rich(SEA),
      expect.objectContaining({ source: 'agent-task-complete', terminalTitle: '✳ The sea' })
    ])
    expect(banners[1]).not.toHaveProperty('agentLastAssistantMessage')
  })

  it("keeps the latest end of a blocking Stop hook turn past main's cooldown, once", async () => {
    await play(BLOCKED_STOP)

    expect(banners).toEqual([
      rich('Draft answer.'),
      rich('Final answer.'),
      rich('Second turn.'),
      rich('Third turn.')
    ])
  })

  const LOST_OPENING_BANNERS = ['First.', 'Second.', 'Draft.', 'Final.', 'Third.', 'Fourth.']

  it('keeps every banner when the host missed a prompt hook, whichever title edge comes first', async () => {
    await play(LOST_OPENINGS)
    expect(banners).toEqual(LOST_OPENING_BANNERS.map(rich))
  })

  it('matches the banners of a paired server that predates the stamp', async () => {
    await play(LOST_OPENINGS, 'old-server')
    expect(banners).toEqual(LOST_OPENING_BANNERS.map(rich))
  })
})
