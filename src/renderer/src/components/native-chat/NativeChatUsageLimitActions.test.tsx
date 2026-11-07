// @vitest-environment happy-dom
import type * as OriginalModule0 from '@/runtime/provider-accounts/observations/runtime-provider-accounts-client'
import '@testing-library/jest-dom/vitest'
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { NativeChatUsageLimitActionsProvider } from './NativeChatUsageLimitActions'
import { NativeChatNoticeRow } from './NativeChatNoticeRow'
import type { NativeChatOrcaStopView } from './native-chat-orca-stop-context'
import { TooltipProvider } from '@/components/ui/tooltip'

import type { NativeChatMessage } from '../../../../shared/native-chat/native-chat-types'
import type { AgentType } from '../../../../shared/agent-status/contracts/agent-status-types'
import type { RuntimeClientTarget } from '../../../../shared/runtime-client-target'
import type { AgentSessionStatusSummary } from '../../../../shared/agent-session/agent-session-wire'
import type { useNativeChatUsageLimitAutoContinue } from './use-native-chat-usage-limit-auto-continue'

const mocks = vi.hoisted(() => ({
  readSnapshot: {
    canSwitchAccount: true,
    transcriptPath: '/work/chat.jsonl'
  },
  follows: true,
  watch: vi.fn(),
  options: vi.fn(),
  snapshot: vi.fn(),
  select: vi.fn(),
  dialog: vi.fn()
}))
let status = new Map<string, Pick<AgentSessionStatusSummary, 'usageLimitContinue'>>()
vi.mock('@/runtime/structured-agent-session-host-capability', () => ({
  useStructuredAgentSessionHostCapabilityState: () => 'supported'
}))
vi.mock('@/runtime/structured-agent-session-status-feed', () => ({
  getStructuredAgentSessionStatusFeed: () => ({
    activate: () => () => {},
    subscribe: () => () => {},
    getSnapshot: () => status
  })
}))
vi.mock('@/runtime/structured-agent-session-client', () => ({
  callStructuredAgentSession: mocks.options
}))
vi.mock('@/runtime/structured-conversation-name', () => ({
  useStructuredChatTabConversationName: () => 'My chat'
}))
vi.mock('@/runtime/use-worktree-runtime-target', () => ({
  useActiveAccountOwner: () => ({
    target: { kind: 'environment', environmentId: 'other' },
    wslHostDistro: null
  })
}))
vi.mock('@/lib/windows-terminal-capabilities', () => ({
  getWindowsTerminalCapabilityOwnerKey: () => 'local',
  useWindowsTerminalCapabilities: () => ({ wslDistros: [] })
}))
vi.mock(
  '@/runtime/provider-accounts/observations/runtime-provider-accounts-client',
  async (importOriginal) => ({
    ...(await importOriginal<typeof OriginalModule0>()),
    fetchProviderAccountsSnapshot: mocks.snapshot,
    watchProviderAccounts: mocks.watch,
    selectClaudeProviderAccount: mocks.select,
    emptyClaudeAccountsState: () => ({
      accounts: [],
      activeAccountId: null,
      activeAccountIdsByRuntime: { host: null, wsl: {} }
    })
  })
)
vi.mock('@/lib/claude-account-switch-sessions', () => ({
  handleRunningClaudeSessionsAfterSwitch: vi.fn()
}))
vi.mock('@/components/agent-session-continuation/AgentSessionContinuationDialog', () => ({
  AgentSessionContinuationDialog: (props: {
    onOpenChange: (open: boolean) => void
    onStarted?: () => void
  }) => {
    mocks.dialog(props)
    return (
      <>
        <button onClick={() => props.onOpenChange(false)}>Cancel hand-off</button>
        <button
          onClick={() => {
            props.onOpenChange(false)
            props.onStarted?.()
          }}
        >
          Start hand-off
        </button>
      </>
    )
  }
}))
beforeEach(() => {
  status = new Map()
  mocks.options.mockResolvedValue(mocks.readSnapshot)
  mocks.watch.mockImplementation((target, handlers) => {
    let closed = false
    void mocks.snapshot(target).then((value: unknown) => {
      if (!closed) {
        handlers.onSnapshot(value)
      }
    })
    return {
      close: () => {
        closed = true
      }
    }
  })
})
afterEach(() => {
  cleanup()
  vi.clearAllMocks()
  vi.useRealTimers()
  mocks.follows = true
})

function row(
  target: RuntimeClientTarget = { kind: 'local' },
  offered = true,
  agent: AgentType = 'claude',
  messages: readonly NativeChatMessage[] = [],
  recovery: Parameters<typeof NativeChatUsageLimitActionsProvider>[0]['recovery'] = {
    readCurrent: true,
    canSwitchAccount: mocks.follows
  },
  automatic?: ReturnType<typeof useNativeChatUsageLimitAutoContinue>
) {
  const view: NativeChatOrcaStopView = {
    hostLabel: null,
    remoteHost: target.kind !== 'local',
    continueAvailable: false,
    offeredTurnItemId: null,
    continueNow: vi.fn(),
    usageLimitTurnItemId: offered ? 'cut' : null,
    usageLimitAutoContinue: automatic,
    onUsageLimitHandOffStarted: automatic?.kind === 'scheduled' ? automatic.cancel : undefined,
    continueUsageLimit: vi.fn()
  }
  return (
    <TooltipProvider>
      <NativeChatUsageLimitActionsProvider
        recovery={recovery}
        view={view}
        pane={{
          tabId: 'tab',
          sessionId: 'chat',
          agent,
          target,
          isVisible: true,
          isFocusedGroup: true
        }}
        directory={{
          worktreeId: 'folder',
          worktreePath: '/work',
          runtimeEnvironmentId: target.kind === 'environment' ? target.environmentId : null
        }}
        messages={messages}
      >
        <NativeChatNoticeRow
          agentName="Claude"
          block={{
            type: 'text',
            text: 'Limited',
            tone: 'warning',
            failure: { kind: 'usageLimitReached' },
            usageLimitTurnItemId: 'cut'
          }}
        />
      </NativeChatUsageLimitActionsProvider>
    </TooltipProvider>
  )
}
function expectInlineActions(accountName: string | null) {
  const leadIn = screen.getByText('Continue this chat without waiting:')
  const actions = leadIn.parentElement
  const handOff = screen.getByRole('button', { name: 'Hand Off to Another Agent' })
  const account = accountName ? screen.getByRole('button', { name: accountName }) : null
  expect(actions).toHaveClass('flex', 'flex-wrap', 'items-center')
  expect(Array.from(actions?.children ?? [])).toEqual([
    leadIn,
    ...(account ? [account.parentElement] : []),
    handOff
  ])
  if (account) {
    expect(account.parentElement).toHaveClass('w-32', 'shrink-0')
  }
}
it('admits one preparation and discards it after Continue supersedes the cut', async () => {
  let answer: (value: typeof mocks.readSnapshot) => void = () => {}
  mocks.options.mockImplementation(
    () =>
      new Promise((resolve) => {
        answer = resolve
      })
  )
  mocks.follows = false
  const view = render(row())
  expect(
    screen.getByText('Continue this chat without waiting:').parentElement?.querySelector('.w-32')
  ).toBeNull()
  expectInlineActions(null)
  const button = screen.getByRole('button', { name: 'Hand Off to Another Agent' })
  fireEvent.click(button)
  fireEvent.click(button)
  expect(mocks.options).toHaveBeenCalledTimes(1)
  expect(button).toBeDisabled()
  view.rerender(row({ kind: 'local' }, false))
  answer(mocks.readSnapshot)
  await waitFor(() => expect(mocks.dialog).not.toHaveBeenCalled())
  view.rerender(row())
  mocks.options.mockResolvedValue(mocks.readSnapshot)
  fireEvent.click(screen.getByRole('button', { name: 'Hand Off to Another Agent' }))
  await screen.findByText('Cancel hand-off')
  fireEvent.click(screen.getByText('Cancel hand-off'))
  expect(screen.queryByText('Cancel hand-off')).toBeNull()
})
