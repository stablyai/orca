// @vitest-environment happy-dom
import { act, cleanup, render, screen } from '@testing-library/react'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import type * as InPlaceSwitchSupport from '@/lib/in-place-switch-support'
import type * as HistorySwitch from '../tab-bar/tab-session-history-switch'
import { TooltipProvider } from '@/components/ui/tooltip'
import { ConfirmationDialogProvider } from '@/components/confirmation-dialog'
import { useAppStore } from '@/store'
import { makeRepo, makeWorktree } from '../worktree-jump-palette-test-fixtures'
import { createGlobalSettingsFixture } from '../../../../shared/global-settings-test-fixture'
import { NativeChatTopRightControls } from './NativeChatTopRightControls'
import { NativeChatResumeInCliButton } from './NativeChatResumeInCliButton'
import type { NativeChatFind } from './use-native-chat-find'

const mocks = vi.hoisted(() => ({
  capability: undefined as boolean | undefined,
  resolveIdentity: vi.fn(),
  resolveSubject: vi.fn()
}))

vi.mock('@/lib/in-place-switch-support', async (original) => ({
  ...(await original<typeof InPlaceSwitchSupport>()),
  useInPlaceSwitchCapability: () => mocks.capability
}))
vi.mock('../tab-bar/tab-session-history-switch', async (original) => {
  const actual = await original<typeof HistorySwitch>()
  mocks.resolveIdentity.mockImplementation(actual.resolveNativeChatCliForkIdentity)
  mocks.resolveSubject.mockImplementation(actual.resolveTabSessionHistorySubject)
  return {
    ...actual,
    resolveNativeChatCliForkIdentity: mocks.resolveIdentity,
    resolveTabSessionHistorySubject: mocks.resolveSubject
  }
})
vi.mock('./use-native-chat-tab-owner', () => ({ useNativeChatTabOwnerWorktreeId: () => 'wt-1' }))

const closedFind: NativeChatFind = {
  isOpen: false,
  query: '',
  setQuery: () => {},
  close: () => {},
  open: undefined,
  onKeyDownCapture: () => {},
  rootRef: { current: null },
  barRef: { current: null },
  inputRef: { current: null },
  revealMatch: () => {}
}

function renderChatHeader(chats = ['chat-1']): void {
  render(
    <ConfirmationDialogProvider>
      <TooltipProvider>
        {chats.map((sessionId) => (
          <div key={sessionId}>
            <NativeChatResumeInCliButton
              tabId={`tab-${sessionId}`}
              worktreeId="wt-1"
              nativeChat={{ sessionId, agent: 'claude' }}
            />
            <NativeChatTopRightControls
              find={closedFind}
              session={{
                tabId: `tab-${sessionId}`,
                sessionId,
                agent: 'claude',
                isVisible: true
              }}
              working={false}
            />
          </div>
        ))}
      </TooltipProvider>
    </ConfirmationDialogProvider>
  )
}

beforeEach(() => {
  useAppStore.setState(useAppStore.getInitialState(), true)
  useAppStore.setState({
    settings: createGlobalSettingsFixture(),
    repos: [makeRepo()],
    worktreesByRepo: { 'repo-1': [makeWorktree('wt-1', 'Worktree', { path: '/repo/wt' })] }
  })
  mocks.capability = undefined
})

afterEach(cleanup)

it("offers the copy and no switch where the chat's host answered that it cannot switch in place", () => {
  mocks.capability = false
  renderChatHeader()
  expect(screen.queryByRole('button', { name: 'Switch to CLI' })).toBeNull()
  expect(screen.getByRole('button', { name: 'Continue with Terminal Agent' })).not.toBeNull()
})

it('shows only the switch, disabled until the host answers, then enabled once it says yes', () => {
  renderChatHeader()
  const pending = screen.getByRole('button', { name: 'Switch to CLI' })
  expect(pending.hasAttribute('disabled')).toBe(true)
  expect(screen.queryByRole('button', { name: 'Continue with Terminal Agent' })).toBeNull()
  cleanup()
  mocks.capability = true
  renderChatHeader()
  expect(screen.getByRole('button', { name: 'Switch to CLI' }).hasAttribute('disabled')).toBe(false)
  expect(screen.queryByRole('button', { name: 'Continue with Terminal Agent' })).toBeNull()
})

it('resolves no History subject for mounted chats on unrelated store writes, at any write count', () => {
  mocks.capability = true
  renderChatHeader(['chat-1', 'chat-2', 'chat-3', 'chat-4'])
  const resolverCalls = (): number =>
    mocks.resolveIdentity.mock.calls.length + mocks.resolveSubject.mock.calls.length
  const unrelatedWrites = (count: number): void => {
    for (let index = 0; index < count; index += 1) {
      act(() => useAppStore.setState({ agentStatusByPaneKey: {} }))
    }
  }
  const before = resolverCalls()
  unrelatedWrites(20)
  expect(resolverCalls()).toBe(before)
  unrelatedWrites(200)
  expect(resolverCalls()).toBe(before)
})
