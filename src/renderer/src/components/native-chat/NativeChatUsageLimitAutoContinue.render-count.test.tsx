// @vitest-environment happy-dom
import type * as OriginalClient from '@/runtime/structured-agent-session-client'
import '@testing-library/jest-dom/vitest'
import { memo, Profiler, useMemo, useSyncExternalStore } from 'react'
import { act, cleanup, render, screen } from '@testing-library/react'
import { afterEach, expect, it, vi } from 'vitest'
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
import { NativeChatNoticeRow } from './NativeChatNoticeRow'
import { NativeChatUsageLimitActionsProvider } from './NativeChatUsageLimitActions'
import type { NativeChatOrcaStopView } from './native-chat-orca-stop-context'
import { useNativeChatUsageLimitAutoContinue } from './use-native-chat-usage-limit-auto-continue'

const mocks = vi.hoisted(() => ({
  subscribeStatus: vi.fn(async () => ({ unsubscribe: () => {} })),
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

afterEach(() => {
  cleanup()
  resetStructuredAgentSessionStatusFeedsForTests()
  vi.clearAllMocks()
})

const LOCAL: RuntimeClientTarget = { kind: 'local' }
const reset = 1_800_000_000_000
const CUT = { turnItemId: 'cut', resetsAt: reset }
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

it('renders usage-limit notice rows only when their own schedule changes', async () => {
  render(<Pane />)
  await act(async () => {})
  const emit = mocks.subscribeStatus.mock.calls[0]?.[1] as unknown as (
    event: AgentSessionStatusEvent
  ) => void
  // Each update in its own turn, counted after the first snapshot settles.
  const step = async (event: AgentSessionStatusEvent): Promise<void> => {
    renders.pane = 0
    renders.rows = 0
    await act(async () => emit(event))
  }
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
