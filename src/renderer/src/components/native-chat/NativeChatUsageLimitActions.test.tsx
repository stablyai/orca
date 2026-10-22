// @vitest-environment happy-dom
import { useContext } from 'react'
import '@testing-library/jest-dom/vitest'
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { useNativeChatHandOff } from './use-native-chat-hand-off'
import { NativeChatUsageLimitActionsProvider } from './NativeChatUsageLimitActions'
import { NativeChatNoticeRow } from './NativeChatNoticeRow'
import {
  NativeChatOrcaStopContext,
  type NativeChatOrcaStopView
} from './native-chat-orca-stop-context'
import { TooltipProvider } from '@/components/ui/tooltip'
import { useAppStore } from '@/store'
import type { NativeChatMessage } from '../../../../shared/native-chat-types'
import type { AgentType } from '../../../../shared/agent-status-types'
import type { RuntimeClientTarget } from '../../../../shared/runtime-client-target'

const mocks = vi.hoisted(() => ({
  readSnapshot: {
    status: 'current',
    canSwitchAccount: true,
    transcriptPath: '/work/chat.txt',
    capturedText: 'Saved context'
  },
  follows: true,
  watch: vi.fn(),
  options: vi.fn(),
  snapshot: vi.fn(),
  select: vi.fn(),
  dialog: vi.fn()
}))
vi.mock('@/runtime/structured-agent-session-client', () => ({
  callStructuredAgentSession: mocks.options,
  supportsStructuredAgentSessionContinuationContext: async () => true
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
vi.mock('@/runtime/runtime-provider-accounts-client', () => ({
  fetchProviderAccountsSnapshot: mocks.snapshot,
  watchProviderAccounts: mocks.watch,
  selectClaudeProviderAccount: mocks.select,
  emptyClaudeAccountsState: () => ({
    accounts: [],
    activeAccountId: null,
    activeAccountIdsByRuntime: { host: null, wsl: {} }
  })
}))
vi.mock('@/lib/claude-account-switch-sessions', () => ({
  handleRunningClaudeSessionsAfterSwitch: vi.fn()
}))
vi.mock('@/components/agent-session-continuation/AgentSessionContinuationDialog', () => ({
  AgentSessionContinuationDialog: (props: { onOpenChange: (open: boolean) => void }) => {
    mocks.dialog(props)
    return <button onClick={() => props.onOpenChange(false)}>Cancel hand-off</button>
  }
}))
beforeEach(() => {
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
  mocks.follows = true
})

function ContinueNow() {
  const view = useContext(NativeChatOrcaStopContext)
  return <button onClick={() => view?.continueUsageLimit()}>Continue cut</button>
}
function Row({
  target,
  offered,
  agent,
  messages
}: {
  target: RuntimeClientTarget
  offered: boolean
  agent: AgentType
  messages: readonly NativeChatMessage[]
}) {
  const pane = {
    tabId: 'tab',
    sessionId: 'chat',
    agent,
    target,
    isVisible: true,
    isFocusedGroup: true
  }
  const handOff = useNativeChatHandOff({
    pane,
    directory: {
      worktreeId: 'folder',
      worktreePath: '/work',
      runtimeEnvironmentId: target.kind === 'environment' ? target.environmentId : null
    },
    messages,
    epoch: 'epoch',
    focusComposer: () => {}
  })
  const view: NativeChatOrcaStopView = {
    hostLabel: null,
    remoteHost: target.kind !== 'local',
    continueAvailable: false,
    offeredTurnItemId: null,
    continueNow: vi.fn(),
    usageLimitTurnItemId: offered ? 'cut' : null,
    continueUsageLimit: vi.fn()
  }
  return (
    <TooltipProvider>
      <NativeChatUsageLimitActionsProvider
        recovery={{ readCurrent: true, canSwitchAccount: mocks.follows }}
        view={view}
        pane={pane}
        handOffState={handOff}
      >
        <ContinueNow />
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
      {handOff.dialog}
    </TooltipProvider>
  )
}
function row(
  target: RuntimeClientTarget = { kind: 'local' },
  offered = true,
  agent: AgentType = 'claude',
  messages: readonly NativeChatMessage[] = []
) {
  return <Row target={target} offered={offered} agent={agent} messages={messages} />
}
function snapshot(count: number) {
  return {
    claude: {
      activeAccountId: 'a0',
      accounts: Array.from({ length: count }, (_, index) => ({
        id: `a${index}`,
        email: `account${index}@example.com`,
        authMethod: 'subscription-oauth',
        createdAt: 1,
        updatedAt: 1,
        lastAuthenticatedAt: 1
      }))
    }
  }
}

it('offers host-owned recovery actions for the current usage-limit cut', async () => {
  const target: RuntimeClientTarget = { kind: 'environment', environmentId: 'chat-host' }
  mocks.snapshot.mockResolvedValue(snapshot(2))
  mocks.select.mockResolvedValue(snapshot(2).claude)
  const original = useAppStore.getState()
  const openSettingsTarget = vi.fn()
  useAppStore.setState({ openSettingsTarget, openSettingsPage: vi.fn() })
  try {
    const view = render(row(target))
    expect(screen.getByRole('button', { name: 'Switch Account' })).toBeDisabled()
    await waitFor(() =>
      expect(screen.getByRole('button', { name: 'Switch Account' })).toBeEnabled()
    )
    fireEvent.pointerDown(screen.getByRole('button', { name: 'Switch Account' }), {
      button: 0,
      ctrlKey: false,
      pointerType: 'mouse'
    })
    fireEvent.click(await screen.findByRole('menuitem', { name: 'account1@example.com' }))
    await waitFor(() =>
      expect(mocks.select).toHaveBeenCalledWith(target, {
        accountId: 'a1',
        runtime: 'host',
        wslDistro: null
      })
    )
    fireEvent.click(screen.getByRole('button', { name: 'Hand Off to Another Agent' }))
    await waitFor(() => expect(mocks.dialog.mock.lastCall?.[0].request).toBeTruthy())
    expect(mocks.dialog.mock.lastCall?.[0].request).toMatchObject({
      worktreeId: 'folder',
      avoidSourceAgent: true,
      launchSource: 'native_chat',
      source: { transcriptPath: '/work/chat.txt', sourceAgent: 'claude', sourceTitle: 'My chat' }
    })
    view.rerender(row(target, false))
    expect(screen.queryByRole('button', { name: 'Continue Now' })).toBeNull()
    expect(screen.queryByText('Continue this chat without waiting:')).toBeNull()
    cleanup()
    mocks.snapshot.mockResolvedValue(snapshot(1))
    render(row(target))
    await waitFor(() => expect(screen.queryByRole('button', { name: /Account/ })).toBeNull())
    const watcher = mocks.watch.mock.lastCall?.[1]
    watcher.onSnapshot(snapshot(2))
    await waitFor(() =>
      expect(screen.getByRole('button', { name: 'Switch Account' })).toBeEnabled()
    )
    cleanup()
    const local: RuntimeClientTarget = { kind: 'local' }
    render(row(local))
    fireEvent.click(await screen.findByRole('button', { name: 'Add Account…' }))
    expect(openSettingsTarget).toHaveBeenCalledWith({
      pane: 'accounts',
      repoId: null,
      sectionId: 'accounts-claude',
      hostScope: local,
      intent: 'native-accounts'
    })
    cleanup()
    mocks.follows = false
    render(row(target, true, 'codex'))
    expect(screen.getByRole('button', { name: 'Hand Off to Another Agent' })).toBeEnabled()
    expect(screen.queryByRole('button', { name: /Account/ })).toBeNull()
  } finally {
    useAppStore.setState({
      openSettingsPage: original.openSettingsPage,
      openSettingsTarget: original.openSettingsTarget
    })
  }
})

it('keeps a deferred account check independent of hand-off and retires it on Continue', async () => {
  mocks.snapshot.mockResolvedValue(snapshot(2))
  mocks.select.mockResolvedValue(snapshot(2).claude)
  const first = Promise.withResolvers<typeof mocks.readSnapshot>()
  const second = Promise.withResolvers<typeof mocks.readSnapshot>()
  let checks = 0
  mocks.options.mockImplementation((_target, method) =>
    method === 'agentSession.options'
      ? ++checks === 1
        ? first.promise
        : second.promise
      : Promise.resolve(mocks.readSnapshot)
  )
  render(row({ kind: 'environment', environmentId: 'chat-host' }))
  const switchAccount = async () => {
    await waitFor(() =>
      expect(screen.getByRole('button', { name: 'Switch Account' })).toBeEnabled()
    )
    fireEvent.pointerDown(screen.getByRole('button', { name: 'Switch Account' }), {
      button: 0,
      ctrlKey: false,
      pointerType: 'mouse'
    })
    fireEvent.click(await screen.findByRole('menuitem', { name: 'account1@example.com' }))
    await waitFor(() => expect(checks).toBeGreaterThan(0))
  }
  fireEvent.click(screen.getByRole('button', { name: 'Hand Off to Another Agent' }))
  await screen.findByText('Cancel hand-off')
  await switchAccount()
  fireEvent.click(screen.getByText('Cancel hand-off'))
  fireEvent.click(screen.getByRole('button', { name: 'Hand Off to Another Agent' }))
  await screen.findByText('Cancel hand-off')
  first.resolve(mocks.readSnapshot)
  await waitFor(() => expect(mocks.select).toHaveBeenCalledOnce())
  fireEvent.click(screen.getByText('Cancel hand-off'))
  cleanup()
  render(row({ kind: 'environment', environmentId: 'chat-host' }))
  await switchAccount()
  await waitFor(() => expect(checks).toBe(2))
  fireEvent.click(screen.getByText('Continue cut'))
  second.resolve(mocks.readSnapshot)
  await waitFor(() => expect(screen.getByRole('button', { name: 'Switch Account' })).toBeEnabled())
  expect(mocks.select).toHaveBeenCalledOnce()
})

it('hands off database-backed chats using labelled recent messages when no native file exists', async () => {
  mocks.options.mockResolvedValue({ status: 'current' })
  render(
    row({ kind: 'local' }, true, 'opencode', [
      {
        id: 'recent',
        role: 'user',
        timestamp: 1,
        source: 'transcript',
        blocks: [{ type: 'text', text: 'Keep the recent task context' }]
      }
    ])
  )
  fireEvent.click(screen.getByRole('button', { name: 'Hand Off to Another Agent' }))
  await waitFor(() => expect(mocks.dialog.mock.lastCall?.[0].request).toBeTruthy())
  const source = mocks.dialog.mock.lastCall?.[0].request.source
  expect(mocks.dialog.mock.lastCall?.[0].request.avoidSourceAgent).toBe(true)
  expect(source).toMatchObject({ sourceAgent: 'opencode', transcriptPath: undefined })
})
