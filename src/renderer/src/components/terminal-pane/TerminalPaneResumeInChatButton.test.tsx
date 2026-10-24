// @vitest-environment happy-dom
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { TooltipProvider } from '@/components/ui/tooltip'
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuTrigger
} from '@/components/ui/dropdown-menu'
import { useAppStore } from '@/store'
import { createGlobalSettingsFixture } from '../../../../shared/global-settings-test-fixture'
import { CliChatResumeMenuItems } from '../tab-bar/CliChatResumeMenuItems'
import type { CliChatResumeSource } from '../tab-bar/cli-chat-resume-source'
import { TerminalPaneResumeInChatButton } from './TerminalPaneResumeInChatButton'

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
vi.mock('../tab-bar/cli-chat-resume-run', () => ({
  runCliChatResume: mocks.run,
  useCliChatResumePending: () => mocks.pending
}))
afterEach(cleanup)
beforeEach(() => {
  mocks.source.agent = 'claude'
  mocks.pending = false
  useAppStore.setState(useAppStore.getInitialState(), true)
  useAppStore.setState({ settings: createGlobalSettingsFixture({ experimentalNativeChat: true }) })
  vi.clearAllMocks()
})

it.each([
  ['claude', 'Resume in New Chat'],
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
  expect(mocks.run).toHaveBeenCalledWith(mocks.source)
  mocks.pending = true
  rerender(
    <TooltipProvider>
      <TerminalPaneResumeInChatButton tabId="tab-1" worktreeId="wt-1" paneKey="tab-1:leaf" />
    </TooltipProvider>
  )
  expect(screen.getByRole('button').getAttribute('aria-busy')).toBe('true')
  expect(screen.getByRole('button').hasAttribute('disabled')).toBe(true)
})

it('hides header and menu switches while Chat UI is off and follows live setting changes', () => {
  mocks.source.agent = 'codex'
  useAppStore.setState({ settings: createGlobalSettingsFixture({ experimentalNativeChat: false }) })
  render(
    <TooltipProvider>
      <TerminalPaneResumeInChatButton tabId="tab-1" worktreeId="wt-1" paneKey="tab-1:leaf" />
      <DropdownMenu open>
        <DropdownMenuTrigger>Open</DropdownMenuTrigger>
        <DropdownMenuContent>
          <CliChatResumeMenuItems tab={{ id: 'tab-1', worktreeId: 'wt-1' }} leadingSeparator />
        </DropdownMenuContent>
      </DropdownMenu>
    </TooltipProvider>
  )
  expect(screen.queryByRole('button', { name: 'Switch to native chat' })).toBeNull()
  expect(screen.queryByRole('menuitem')).toBeNull()
  act(() => {
    useAppStore.getState().setPaneForegroundAgent('tab-1:leaf', {
      agent: 'codex',
      shellForeground: false
    })
  })
  expect(screen.queryByRole('button', { name: 'Switch to native chat', hidden: true })).toBeNull()
  expect(screen.queryByRole('menuitem')).toBeNull()
  act(() => {
    useAppStore.setState({
      settings: createGlobalSettingsFixture({ experimentalNativeChat: true })
    })
  })
  expect(screen.getByRole('button', { name: 'Switch to native chat', hidden: true })).toBeTruthy()
  expect(screen.getByRole('menuitem', { name: 'Switch to native chat' })).toBeTruthy()
  act(() => {
    useAppStore.setState({
      settings: createGlobalSettingsFixture({ experimentalNativeChat: false })
    })
  })
  expect(screen.queryByRole('button', { name: 'Switch to native chat', hidden: true })).toBeNull()
  expect(screen.queryByRole('menuitem')).toBeNull()
})
