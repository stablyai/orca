// @vitest-environment happy-dom
import { act, cleanup, fireEvent, render, screen, within } from '@testing-library/react'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { useAppStore } from '@/store'
import { TooltipProvider } from '@/components/ui/tooltip'
import { ConfirmationDialogProvider } from '@/components/confirmation-dialog'
import { resetStructuredAgentSessionStatusFeedsForTests } from '@/runtime/structured-agent-session-status-feed'
import type { AiVaultListArgs, AiVaultListResult } from '../../../../shared/ai-vault-types'
import AiVaultPanel from './AiVaultPanel'
import { resetAiVaultForcedRescanThrottleForTest } from './ai-vault-session-refresh'
import { resetInputQuietSchedulerForTest } from '@/lib/input-quiet-scheduler'
import {
  conversationSessions,
  conversationStore,
  conversationWorktrees
} from '../sidebar/ProjectConversationList.test-fixture'

vi.mock('@/runtime/structured-agent-session-client', () => ({
  subscribeStructuredAgentSessionStatus: async () => ({ unsubscribe: () => {} })
}))
vi.mock('../sidebar/use-conversation-preferences', () => ({
  useConversationPreferences: () => ({
    preferences: { revision: 0, entries: {} },
    setPreference: vi.fn(),
    projectVisibilitySupported: true,
    setProjectHidden: vi.fn()
  })
}))
vi.mock('../sidebar/SidebarConversationStart', () => ({
  SidebarConversationStart: () => null
}))
vi.mock('./use-ai-vault-session-display-title', () => ({
  useAiVaultSessionDisplayTitle: (session: { title: string }) => session.title
}))
const listSessions = vi.fn<(args: AiVaultListArgs) => Promise<AiVaultListResult>>()
const initialState = useAppStore.getInitialState()

beforeEach(() => {
  vi.useFakeTimers()
  resetInputQuietSchedulerForTest()
  resetStructuredAgentSessionStatusFeedsForTests()
  resetAiVaultForcedRescanThrottleForTest()
  useAppStore.setState(initialState, true)
  useAppStore.setState({ ...conversationStore, activeWorkspaceExecutionHostId: 'local' })
  listSessions.mockReset().mockResolvedValue({
    sessions: conversationSessions,
    issues: [],
    scannedAt: '2026-10-29T00:00:00Z'
  })
  Object.defineProperty(window, 'api', {
    configurable: true,
    value: {
      aiVault: {
        listSessions,
        cancelListSessions: vi.fn().mockResolvedValue(undefined),
        onWindowFocused: () => () => {}
      }
    }
  })
})
afterEach(() => {
  cleanup()
  resetStructuredAgentSessionStatusFeedsForTests()
  useAppStore.setState(initialState, true)
  vi.useRealTimers()
})

it('keeps the loaded project list and expanded chats while navigating across projects, with explicit refresh still available', async () => {
  render(
    <TooltipProvider>
      <ConfirmationDialogProvider>
        <AiVaultPanel conversationNavigation />
      </ConfirmationDialogProvider>
    </TooltipProvider>
  )
  await act(async () => {
    await vi.advanceTimersByTimeAsync(1200)
  })
  const project = screen.getByRole('region', { name: 'Orca' })
  fireEvent.click(within(project).getByRole('button', { name: 'Show more' }))
  expect(project.querySelectorAll('[data-conversation-id]')).toHaveLength(7)
  const list = project.parentElement
  if (!list) {
    throw new Error('Expected the project list scroll container')
  }
  list.scrollTop = 240
  const requests = listSessions.mock.calls.length
  listSessions.mockImplementation(() => new Promise(() => {}))

  for (const worktree of [conversationWorktrees[0]!, conversationWorktrees[1]!]) {
    await act(async () => {
      useAppStore.setState({ activeWorktreeId: worktree.id, activeRepoId: worktree.repoId })
      await vi.advanceTimersByTimeAsync(1200)
    })
    expect(listSessions).toHaveBeenCalledTimes(requests)
    expect(screen.getByRole('region', { name: 'Orca' })).toBe(project)
    expect(project.querySelectorAll('[data-conversation-id]')).toHaveLength(7)
    expect(list.scrollTop).toBe(240)
  }

  fireEvent.click(screen.getByRole('button', { name: 'Refresh Session History' }))
  expect(listSessions).toHaveBeenCalledTimes(requests + 1)
  expect(listSessions.mock.lastCall?.[0].force).toBe(true)
  expect(project.querySelectorAll('[data-conversation-id]')).toHaveLength(7)
})

it.each([false, true])(
  'shows scan warnings when project history is partial: %s',
  async (hasRows) => {
    listSessions.mockResolvedValue({
      sessions: hasRows ? conversationSessions : [],
      issues: [
        {
          kind: 'host',
          executionHostId: 'local',
          agent: 'codex',
          path: '/history',
          message: 'History host unreachable'
        }
      ],
      scannedAt: '2026-10-29T00:00:00Z'
    })
    render(
      <TooltipProvider>
        <ConfirmationDialogProvider>
          <AiVaultPanel conversationNavigation />
        </ConfirmationDialogProvider>
      </TooltipProvider>
    )
    await act(async () => {
      await vi.advanceTimersByTimeAsync(1200)
    })
    expect(screen.getByText(/History host unreachable/)).toBeTruthy()
    if (hasRows) {
      expect(screen.getByText(conversationSessions[0]!.title)).toBeTruthy()
    }
  }
)
