// @vitest-environment happy-dom
import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { TooltipProvider } from '@/components/ui/tooltip'
import { TerminalPaneResumeInChatButton } from './TerminalPaneResumeInChatButton'
import type { CliChatResumeSource } from '../tab-bar/cli-chat-resume-source'

const LOCAL_SOURCE: CliChatResumeSource = {
  tabId: 'tab-1',
  workspaceId: 'wt-1',
  paneKey: 'tab-1:leaf',
  agent: 'claude',
  providerSessionId: 'provider-1',
  executionHostId: 'local'
}

const mocks = vi.hoisted(() => {
  const source: { current: CliChatResumeSource | null } = { current: null }
  return { source, resolve: vi.fn(), run: vi.fn(), pending: false }
})
vi.mock('@/store', () => ({
  useAppStore: (selector: (state: Record<string, unknown>) => unknown) => selector({})
}))
vi.mock('../tab-bar/cli-chat-resume-source', () => ({
  resolveCliChatResumeSource: (_state: unknown, args: unknown) => {
    mocks.resolve(args)
    return mocks.source.current
  }
}))
vi.mock('../tab-bar/cli-chat-resume-run', () => ({
  runCliChatResume: mocks.run,
  useCliChatResumePending: () => mocks.pending
}))
beforeEach(() => {
  mocks.source.current = LOCAL_SOURCE
})
afterEach(cleanup)

it('dispatches the exact pane with owner-opening intent and shares pending', () => {
  const { rerender } = render(
    <TooltipProvider>
      <TerminalPaneResumeInChatButton tabId="tab-1" worktreeId="wt-1" paneKey="tab-1:leaf" />
    </TooltipProvider>
  )
  fireEvent.click(screen.getByRole('button', { name: 'Continue in Chat UI' }))
  expect(mocks.resolve).toHaveBeenCalledWith({
    tab: { id: 'tab-1', worktreeId: 'wt-1' },
    paneKey: 'tab-1:leaf'
  })
  expect(mocks.run).toHaveBeenCalledWith(LOCAL_SOURCE, true)
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
  mocks.source.current = {
    ...LOCAL_SOURCE,
    executionHostId: 'runtime:server-1',
    hostUpdateRequired: true
  }
  render(
    <TooltipProvider delayDuration={0}>
      <TerminalPaneResumeInChatButton tabId="tab-1" worktreeId="wt-1" paneKey="tab-1:leaf" />
    </TooltipProvider>
  )
  const button = screen.getByRole('button', {
    name: 'Continue in Chat UI. Update Orca on this host to continue in Chat UI.'
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
