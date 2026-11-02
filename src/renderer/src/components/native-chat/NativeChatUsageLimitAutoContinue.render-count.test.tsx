// @vitest-environment happy-dom
import type * as OriginalClient from '@/runtime/structured-agent-session-client'
import '@testing-library/jest-dom/vitest'
import { memo, Profiler, useMemo, useSyncExternalStore } from 'react'
import { act, cleanup, render, screen } from '@testing-library/react'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { TooltipProvider } from '@/components/ui/tooltip'
import {
  getStructuredAgentSessionStatusFeed,
  resetStructuredAgentSessionStatusFeedsForTests
} from '@/runtime/structured-agent-session-status-feed'
import type {
  AgentSessionStatusEvent,
  AgentSessionStatusSummary
} from '../../../../shared/agent-session/agent-session-wire'
import type { RuntimeClientTarget } from '../../../../shared/runtime-client-target'
import { NATIVE_CHAT_USAGE_LIMIT_MAX_OVERDUE_MS } from '../../../../shared/native-chat/native-chat-usage-limit-cut'
import { NativeChatNoticeRow } from './NativeChatNoticeRow'
import { NativeChatUsageLimitActionsProvider } from './NativeChatUsageLimitActions'
import type { NativeChatOrcaStopView } from './native-chat-orca-stop-context'
import { useNativeChatUsageLimitAutoContinue } from './use-native-chat-usage-limit-auto-continue'

const mocks = vi.hoisted(() => ({
  subscribeStatus: vi.fn<typeof OriginalClient.subscribeStructuredAgentSessionStatus>(async () => ({
    unsubscribe: () => {}
  })),
  call: vi.fn()
}))
vi.mock('@/runtime/structured-agent-session-host-capability', () => ({
  useStructuredAgentSessionHostCapabilityState: () => 'supported'
}))
vi.mock('@/runtime/structured-agent-session-client', async (importOriginal) => ({
  ...(await importOriginal<typeof OriginalClient>()),
  callStructuredAgentSession: mocks.call,
  subscribeStructuredAgentSessionStatus: mocks.subscribeStatus
}))
vi.mock('@/runtime/structured-conversation-name', () => ({
  useStructuredChatTabConversationName: () => 'My chat'
}))

const LOCAL: RuntimeClientTarget = { kind: 'local' }
const reset = 1_800_000_000_000
const CUT = { turnItemId: 'cut', resetsAt: reset, turnEndedAt: reset - 120_000 }

beforeEach(() => {
  // The row's minute clock runs on intervals; the status feed keeps its real timeouts.
  vi.useFakeTimers({ toFake: ['Date', 'setInterval', 'clearInterval'] })
  vi.setSystemTime(reset - 60_000)
})
afterEach(() => {
  cleanup()
  resetStructuredAgentSessionStatusFeedsForTests()
  vi.clearAllMocks()
  vi.useRealTimers()
})
const PANE = {
  tabId: 'tab',
  sessionId: 'chat',
  agent: 'codex',
  target: LOCAL,
  isVisible: true,
  isFocusedGroup: true
} as const
const DIRECTORY = { worktreeId: 'folder', worktreePath: '/work', runtimeEnvironmentId: null }
const RECOVERY = { readCurrent: true, canSwitchAccount: false }
const MESSAGES: never[] = []
const renders = { pane: 0, rows: 0 }

function summary(
  sessionId: string,
  fields: Partial<AgentSessionStatusSummary> = {}
): AgentSessionStatusSummary {
  return {
    sessionId,
    workspaceId: 'wt-1',
    agent: 'codex',
    status: 'idle',
    latestPrompt: 'hello',
    updatedAt: 1,
    ...fields
  }
}
const limited = (
  state: 'scheduled' | 'cancelled',
  fields: Partial<AgentSessionStatusSummary> = {}
) =>
  summary('chat', { usageLimitContinue: { turnItemId: 'cut', resetsAt: reset, state }, ...fields })

// Behind the transcript's row memo, so only a context change can render the notice row.
const Rows = memo(function Rows() {
  return (
    <Profiler id="notice-rows" onRender={() => (renders.rows += 1)}>
      <NativeChatNoticeRow
        agentName="Codex"
        block={{
          type: 'text',
          text: 'Limited',
          tone: 'warning',
          failure: { kind: 'usageLimitReached' },
          usageLimitTurnItemId: 'cut'
        }}
      />
    </Profiler>
  )
})

function Pane() {
  // The chat pane renders on every status change; the rows must not follow it.
  const feed = getStructuredAgentSessionStatusFeed(LOCAL)
  useSyncExternalStore(feed.subscribe, feed.getSnapshot)
  renders.pane += 1
  const automatic = useNativeChatUsageLimitAutoContinue(LOCAL, 'chat', CUT)
  const view = useMemo<NativeChatOrcaStopView>(
    () => ({
      hostLabel: null,
      remoteHost: false,
      continueAvailable: true,
      offeredTurnItemId: null,
      continueNow: () => {},
      usageLimitTurnItemId: 'cut',
      usageLimitAutoContinue: automatic,
      onUsageLimitHandOffStarted: automatic?.kind === 'scheduled' ? automatic.cancel : undefined,
      continueUsageLimit: () => {}
    }),
    [automatic]
  )
  return (
    <TooltipProvider>
      <NativeChatUsageLimitActionsProvider
        pane={PANE}
        directory={DIRECTORY}
        messages={MESSAGES}
        view={view}
        recovery={RECOVERY}
      >
        <Rows />
      </NativeChatUsageLimitActionsProvider>
    </TooltipProvider>
  )
}

async function renderPane() {
  render(<Pane />)
  await act(async () => {})
  const emit = mocks.subscribeStatus.mock.calls[0]?.[1]
  if (!emit) {
    throw new Error('the status feed did not subscribe')
  }
  // Each update in its own turn, counted after the first snapshot settles.
  return async (event: AgentSessionStatusEvent | 'minute'): Promise<void> => {
    renders.pane = 0
    renders.rows = 0
    await act(async () => (event === 'minute' ? vi.advanceTimersByTime(60_000) : emit(event)))
  }
}

it('renders usage-limit notice rows only when their own schedule changes', async () => {
  const step = await renderPane()
  await step({ type: 'snapshot', sessions: [limited('scheduled'), summary('other')] })
  expect(screen.getByText(/Orca will continue this chat at/)).toBeInTheDocument()
  expect(screen.getByRole('button', { name: 'Hand Off to Another Agent' })).toBeInTheDocument()

  await step({ type: 'status', session: summary('other', { status: 'working', updatedAt: 2 }) })
  expect(renders.pane).toBeGreaterThan(0)
  expect(renders.rows).toBe(0)

  await step({
    type: 'status',
    session: limited('scheduled', {
      conversationName: 'Renamed',
      model: 'other-model',
      updatedAt: 3
    })
  })
  expect(renders.pane).toBeGreaterThan(0)
  expect(renders.rows).toBe(0)

  await step({ type: 'status', session: limited('cancelled', { updatedAt: 4 }) })
  expect(renders.rows).toBeGreaterThan(0)
  expect(screen.getByText("Orca won't continue this chat automatically.")).toBeInTheDocument()
})

it('re-renders notice rows on the shared minute clock only when the cut ages out', async () => {
  const step = await renderPane()
  await step({ type: 'snapshot', sessions: [limited('scheduled')] })
  await step('minute')
  expect(renders.pane).toBeGreaterThan(0)
  expect(renders.rows).toBe(0)

  vi.setSystemTime(reset + NATIVE_CHAT_USAGE_LIMIT_MAX_OVERDUE_MS - 1_000)
  await step('minute')
  expect(renders.rows).toBeGreaterThan(0)
  expect(screen.queryByText(/Orca will continue this chat at/)).toBeNull()
  expect(screen.getByRole('button', { name: 'Hand Off to Another Agent' })).toBeInTheDocument()
  // Nothing left to expire, so the clock no longer renders the pane.
  await step('minute')
  expect(renders).toEqual({ pane: 0, rows: 0 })
})
