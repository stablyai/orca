// @vitest-environment happy-dom
import '@testing-library/jest-dom/vitest'
import { useMemo } from 'react'
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { TooltipProvider } from '@/components/ui/tooltip'
import type { AgentSessionStatusSummary } from '../../../../shared/agent-session/agent-session-wire'
import type { RuntimeClientTarget } from '../../../../shared/runtime-client-target'
import { NATIVE_CHAT_USAGE_LIMIT_MAX_OVERDUE_MS } from '../../../../shared/native-chat/native-chat-usage-limit-cut'
import { NativeChatNoticeRow } from './NativeChatNoticeRow'
import { NativeChatOrcaStopContext } from './native-chat-orca-stop-context'
import { useNativeChatUsageLimitAutoContinue } from './use-native-chat-usage-limit-auto-continue'

const mocks = vi.hoisted(() => {
  const state: {
    capability: string
    summary: Pick<AgentSessionStatusSummary, 'usageLimitContinue'> | undefined
  } = { capability: 'supported', summary: undefined }
  return Object.assign(state, {
    call: vi.fn(async () => ({ ok: true })),
    feed: { activate: () => () => {}, subscribe: () => () => {}, getSnapshot: () => new Map() }
  })
})
vi.mock('@/runtime/structured-agent-session-host-capability', () => ({
  useStructuredAgentSessionHostCapabilityState: () => mocks.capability
}))
vi.mock('@/runtime/structured-agent-session-client', () => ({
  callStructuredAgentSession: mocks.call
}))
vi.mock('@/runtime/structured-agent-session-status-feed', () => ({
  getStructuredAgentSessionStatusFeed: () => mocks.feed
}))
vi.mock('./NativeChatUsageLimitActions', () => ({ NativeChatUsageLimitActions: () => null }))

const reset = 1_800_000_000_000
beforeEach(() => {
  vi.useFakeTimers({ toFake: ['Date'] })
  vi.setSystemTime(reset - 60_000)
})
afterEach(() => {
  cleanup()
  vi.clearAllMocks()
  vi.useRealTimers()
})
const LOCAL: RuntimeClientTarget = { kind: 'local' }
function Row({ target = LOCAL, known = true }: { target?: RuntimeClientTarget; known?: boolean }) {
  const state = useNativeChatUsageLimitAutoContinue(target, 'chat', {
    turnItemId: 'cut',
    turnEndedAt: reset - 120_000,
    ...(known ? { resetsAt: reset } : {})
  })
  const value = useMemo(
    () => ({
      hostLabel: null,
      remoteHost: target.kind !== 'local',
      continueAvailable: false,
      offeredTurnItemId: null,
      continueNow: () => {},
      usageLimitTurnItemId: 'cut',
      continueUsageLimit: () => {},
      usageLimitAutoContinue: state
    }),
    [state, target.kind]
  )
  return (
    <TooltipProvider>
      <NativeChatOrcaStopContext.Provider value={value}>
        <NativeChatNoticeRow
          block={{
            type: 'text',
            text: 'Usage limit',
            usageLimitTurnItemId: 'cut',
            failure: { kind: 'usageLimitReached', usageLimit: { resetsAt: reset } }
          }}
        />
      </NativeChatOrcaStopContext.Provider>
    </TooltipProvider>
  )
}
function setState(state: NonNullable<AgentSessionStatusSummary['usageLimitContinue']>['state']) {
  mocks.capability = 'supported'
  mocks.summary = { usageLimitContinue: { turnItemId: 'cut', resetsAt: reset, state } }
  const snapshot = new Map([['chat', mocks.summary]])
  mocks.feed.getSnapshot = () => snapshot
}

it('shows the setting link, scheduled cancel action, and cancellation in the usage-limit row', async () => {
  setState('off')
  const view = render(<Row />)
  expect(
    screen.getByRole('button', { name: 'Continue automatically when limits reset' })
  ).toBeInTheDocument()
  setState('scheduled')
  view.rerender(<Row />)
  expect(screen.getByText(/Orca will continue this chat at/)).toBeInTheDocument()
  fireEvent.click(screen.getByRole('button', { name: "Don't continue" }))
  await waitFor(() =>
    expect(mocks.call).toHaveBeenCalledWith(
      { kind: 'local' },
      'agentSession.cancelUsageLimitContinue',
      { sessionId: 'chat', turnItemId: 'cut', resetsAt: reset }
    )
  )
  setState('cancelled')
  view.rerender(<Row />)
  expect(screen.getByText("Orca won't continue this chat automatically.")).toBeInTheDocument()
  setState('failed')
  view.rerender(<Row />)
  expect(screen.getByText("Orca won't continue this chat automatically.")).toBeInTheDocument()
})

it('hides new controls on old hosts, missing resets, stale summaries, and remote off states', () => {
  setState('scheduled')
  mocks.capability = 'unsupported'
  const view = render(<Row />)
  expect(screen.queryByText(/Orca will continue/)).toBeNull()
  mocks.capability = 'supported'
  view.rerender(<Row known={false} />)
  expect(screen.queryByText(/Orca will continue/)).toBeNull()
  setState('off')
  view.rerender(<Row target={{ kind: 'environment', environmentId: 'server' }} />)
  expect(
    screen.queryByRole('button', { name: 'Continue automatically when limits reset' })
  ).toBeNull()
  mocks.summary!.usageLimitContinue!.turnItemId = 'old-cut'
  view.rerender(<Row />)
  expect(
    screen.queryByRole('button', { name: 'Continue automatically when limits reset' })
  ).toBeNull()
})

it('shows only the manual actions once a cut is more than a day past its reset, setting on or off', () => {
  vi.setSystemTime(reset + NATIVE_CHAT_USAGE_LIMIT_MAX_OVERDUE_MS + 1_000)
  // A summary from before the cutoff: 'off' with the setting off, 'scheduled' with it on.
  for (const state of ['off', 'scheduled'] as const) {
    setState(state)
    const view = render(<Row />)
    expect(
      screen.queryByRole('button', { name: 'Continue automatically when limits reset' })
    ).toBeNull()
    expect(screen.queryByText(/Orca will continue/)).toBeNull()
    expect(screen.queryByRole('button', { name: "Don't continue" })).toBeNull()
    expect(screen.getByRole('button', { name: 'Continue Now' })).toBeInTheDocument()
    view.unmount()
  }
})
