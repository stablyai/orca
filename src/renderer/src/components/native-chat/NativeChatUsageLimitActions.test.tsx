// @vitest-environment happy-dom
import type * as OriginalModule0 from '@/runtime/runtime-provider-accounts-client'
import '@testing-library/jest-dom/vitest'
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { NativeChatUsageLimitActionsProvider } from './NativeChatUsageLimitActions'
import { NativeChatNoticeRow } from './NativeChatNoticeRow'
import type { NativeChatOrcaStopView } from './native-chat-orca-stop-context'
import { TooltipProvider } from '@/components/ui/tooltip'
import { useAppStore } from '@/store'
import { buildAgentSessionContinuationPrompt } from '@/lib/agent-session-continuation'
import type { NativeChatMessage } from '../../../../shared/native-chat/native-chat-types'
import type { AgentType } from '../../../../shared/agent-status-types'
import type { RuntimeClientTarget } from '../../../../shared/runtime-client-target'

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
vi.mock('@/runtime/runtime-provider-accounts-client', async (importOriginal) => ({
  ...(await importOriginal<typeof OriginalModule0>()),
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

function row(
  target: RuntimeClientTarget = { kind: 'local' },
  offered = true,
  agent: AgentType = 'claude',
  messages: readonly NativeChatMessage[] = [],
  recovery: Parameters<typeof NativeChatUsageLimitActionsProvider>[0]['recovery'] = {
    readCurrent: true,
    canSwitchAccount: mocks.follows
  }
) {
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
    const view = render(
      row(target, true, 'claude', [], { readCurrent: false, canSwitchAccount: undefined })
    )
    expectInlineActions('Switch Account')
    expect(screen.getByRole('button', { name: 'Switch Account' })).toBeDisabled()
    expect(screen.getByRole('button', { name: 'Hand Off to Another Agent' })).toBeDisabled()
    view.rerender(row(target))
    expect(screen.getByRole('button', { name: 'Switch Account' })).toBeDisabled()
    await waitFor(() =>
      expect(screen.getByRole('button', { name: 'Switch Account' })).toBeEnabled()
    )
    expectInlineActions('Switch Account')
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
    await waitFor(() => expect(mocks.dialog).toHaveBeenCalled())
    expect(mocks.dialog.mock.lastCall?.[0].request).toMatchObject({
      worktreeId: 'folder',
      avoidSourceAgent: true,
      launchSource: 'native_chat',
      source: { transcriptPath: '/work/chat.jsonl', sourceAgent: 'claude', sourceTitle: 'My chat' }
    })
    view.rerender(row(target, false))
    expect(screen.queryByRole('button', { name: 'Continue Now' })).toBeNull()
    expect(screen.queryByText('Continue this chat without waiting:')).toBeNull()
    cleanup()
    mocks.snapshot.mockResolvedValue(snapshot(1))
    render(row(target))
    await waitFor(() => expect(screen.queryByRole('button', { name: /Account/ })).toBeNull())
    expect(
      screen.getByText('Continue this chat without waiting:').parentElement?.querySelector('.w-32')
    ).toHaveClass('empty:hidden')
    const watcher = mocks.watch.mock.lastCall?.[1]
    watcher.onSnapshot(snapshot(2))
    await waitFor(() =>
      expect(screen.getByRole('button', { name: 'Switch Account' })).toBeEnabled()
    )
    expectInlineActions('Switch Account')
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
    expectInlineActions(null)
  } finally {
    useAppStore.setState({
      openSettingsPage: original.openSettingsPage,
      openSettingsTarget: original.openSettingsTarget
    })
  }
})

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

it('hands off database-backed chats using labelled recent messages when no native file exists', async () => {
  mocks.options.mockResolvedValue({ canSwitchAccount: false })
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
  await waitFor(() => expect(mocks.dialog).toHaveBeenCalled())
  const source = mocks.dialog.mock.lastCall?.[0].request.source
  expect(source.transcriptPath).toBeUndefined()
  expect(buildAgentSessionContinuationPrompt(source, 'focused')).toContain(
    'A saved session transcript was unavailable, so use these recent chat messages:'
  )
  expect(source.capturedText).toContain('user: Keep the recent task context')
  expect(buildAgentSessionContinuationPrompt(source, 'full')).toBeNull()
})
