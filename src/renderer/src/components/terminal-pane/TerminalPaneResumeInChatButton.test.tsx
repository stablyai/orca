// @vitest-environment happy-dom
import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, expect, it, vi } from 'vitest'
import { TooltipProvider } from '@/components/ui/tooltip'
import { TerminalPaneResumeInChatButton } from './TerminalPaneResumeInChatButton'

const mocks = vi.hoisted(() => ({
  source: {
    tabId: 'tab-1',
    workspaceId: 'wt-1',
    paneKey: 'tab-1:leaf',
    agent: 'claude',
    providerSessionId: 'provider-1',
    executionHostId: 'local'
  },
  resolve: vi.fn(),
  run: vi.fn(),
  pending: false
}))
vi.mock('@/store', () => ({
  useAppStore: (selector: (state: Record<string, unknown>) => unknown) => selector({})
}))
vi.mock('../tab-bar/cli-chat-resume-source', () => ({
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

it('dispatches the exact pane with owner-opening intent and shares pending', () => {
  const { rerender } = render(
    <TooltipProvider>
      <TerminalPaneResumeInChatButton tabId="tab-1" worktreeId="wt-1" paneKey="tab-1:leaf" />
    </TooltipProvider>
  )
  fireEvent.click(screen.getByRole('button', { name: 'Switch to Chat UI' }))
  expect(mocks.resolve).toHaveBeenCalledWith({
    tab: { id: 'tab-1', worktreeId: 'wt-1' },
    paneKey: 'tab-1:leaf'
  })
  expect(mocks.run).toHaveBeenCalledWith(mocks.source, true)
  mocks.pending = true
  rerender(
    <TooltipProvider>
      <TerminalPaneResumeInChatButton tabId="tab-1" worktreeId="wt-1" paneKey="tab-1:leaf" />
    </TooltipProvider>
  )
  expect(screen.getByRole('button').getAttribute('aria-busy')).toBe('true')
  expect(screen.getByRole('button').hasAttribute('disabled')).toBe(true)
})
