// @vitest-environment happy-dom
import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { TooltipProvider } from '@/components/ui/tooltip'
import { useAppStore } from '@/store'
import { createGlobalSettingsFixture } from '../../../../shared/global-settings-test-fixture'
import { TerminalPaneResumeInChatButton } from './TerminalPaneResumeInChatButton'
import type { CliChatResumeSource } from '../tab-bar/cli-chat-resume-source'

const mocks = vi.hoisted(() => {
  const source: CliChatResumeSource = {
    tabId: 'tab-1',
    workspaceId: 'wt-1',
    paneKey: 'tab-1:leaf',
    agent: 'claude',
    providerSessionId: 'provider-1',
    executionHostId: 'local',
    ptyId: 'pty-1'
  }
  return { source, resolve: vi.fn(), run: vi.fn(), pending: false }
})
vi.mock('../tab-bar/cli-chat-resume-source', () => ({
  useCliChatResumeCapability: (_worktreeId: string, agent: string) => agent === 'codex',
  resolveCliChatResumeSource: (_state: unknown, args: unknown) => {
    mocks.resolve(args)
    return mocks.source
  }
}))
vi.mock('@/lib/conversation-surface-switch', () => ({
  runCliChatResume: mocks.run,
  useConversationSwitchReadiness: (args: { source?: CliChatResumeSource } | null) => ({
    ready: !mocks.pending && !args?.source?.hostUpdateRequired,
    pending: mocks.pending
  }),
  // The real hook only delays the busy look; pending already disables the button.
  useConversationSwitchBusy: (pending: boolean) => pending
}))
afterEach(cleanup)
beforeEach(() => {
  mocks.source.agent = 'claude'
  delete mocks.source.hostUpdateRequired
  mocks.pending = false
  useAppStore.setState(useAppStore.getInitialState(), true)
  useAppStore.setState({ settings: createGlobalSettingsFixture() })
  vi.clearAllMocks()
})

it.each([
  ['claude', 'Switch to native chat'],
  ['codex', 'Switch to native chat']
] as const)('offers the %s action for the exact pane and shares pending', (agent, label) => {
  mocks.source.agent = agent
  if (agent === 'claude') {
    useAppStore.getState().setPaneForegroundAgent('tab-1:leaf', { agent, shellForeground: false })
  }
  const { rerender } = render(
    <TooltipProvider>
      <TerminalPaneResumeInChatButton tabId="tab-1" worktreeId="wt-1" paneKey="tab-1:leaf" />
    </TooltipProvider>
  )
  fireEvent.click(screen.getByRole('button', { name: label }))
  expect(mocks.resolve).toHaveBeenCalledWith({
    tab: { id: 'tab-1', worktreeId: 'wt-1' },
    paneKey: 'tab-1:leaf'
  })
  expect(mocks.run).toHaveBeenCalledWith(mocks.source, expect.any(Function))
  mocks.pending = true
  rerender(
    <TooltipProvider>
      <TerminalPaneResumeInChatButton tabId="tab-1" worktreeId="wt-1" paneKey="tab-1:leaf" />
    </TooltipProvider>
  )
  expect(screen.getByRole('button').getAttribute('aria-busy')).toBe('true')
  expect(screen.getByRole('button').hasAttribute('disabled')).toBe(true)
})

it('keeps an older host visible but disabled, telling the user to update it', async () => {
  mocks.pending = false
  mocks.run.mockClear()
  Object.assign(mocks.source, {
    executionHostId: 'runtime:server-1',
    hostUpdateRequired: true
  })
  render(
    <TooltipProvider delayDuration={0}>
      <TerminalPaneResumeInChatButton tabId="tab-1" worktreeId="wt-1" paneKey="tab-1:leaf" />
    </TooltipProvider>
  )
  const button = screen.getByRole('button', {
    name: 'Switch to native chat. Update Orca on this host to continue in Chat UI.'
  })
  expect(button.hasAttribute('disabled')).toBe(true)
  const trigger = button.parentElement
  if (trigger) {
    fireEvent.focus(trigger)
  }
  expect(
    (await screen.findAllByText('Update Orca on this host to continue in Chat UI.')).length
  ).toBeGreaterThan(0)
  expect(mocks.run).not.toHaveBeenCalled()
})

vi.mock('@/components/confirmation-dialog-context', async (original) => ({
  ...(await original<Record<string, unknown>>()),
  useConfirmationDialog: () => vi.fn(async () => false)
}))
