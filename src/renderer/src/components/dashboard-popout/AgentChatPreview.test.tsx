// @vitest-environment happy-dom
import '@testing-library/jest-dom/vitest'
import { act, cleanup, render, screen, waitFor } from '@testing-library/react'
import { afterEach, expect, it, vi } from 'vitest'
import type { AgentSessionHistoryPage } from '../../../../shared/agent-session/agent-session-wire'

const mocks = vi.hoisted(() => ({ call: vi.fn(), subscribe: vi.fn(), read: vi.fn() }))
vi.mock('@/runtime/structured-agent-session-client', () => ({
  callStructuredAgentSession: mocks.call,
  subscribeStructuredAgentSession: mocks.subscribe
}))
vi.mock('@/attention/agent-subject-read-actions', async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  notifyStructuredAttentionView: mocks.read
}))
import AgentChatPreview from './AgentChatPreview'
import { TooltipProvider } from '../ui/tooltip'
import { getStructuredAgentSessionReadOwner } from '../native-chat/session/structured/read/structured-agent-session-read-owner'
import { resetStructuredAgentSessionReadOwnersForTests } from '../native-chat/session/structured/read/structured-agent-session-read-owner-registry'
import { useAppStore } from '@/store'

const originalState = useAppStore.getState()

afterEach(() => {
  cleanup()
  resetStructuredAgentSessionReadOwnersForTests()
  vi.useRealTimers()
  useAppStore.setState({
    unifiedTabsByWorktree: originalState.unifiedTabsByWorktree,
    observeTerminalGitHubPullRequestLink: originalState.observeTerminalGitHubPullRequestLink
  })
  vi.clearAllMocks()
})

it('reads the selected remote chat without acquiring a provider or acknowledging attention', async () => {
  const page: AgentSessionHistoryPage = {
    sessionId: 'chat',
    epoch: 'epoch',
    direction: 'tail',
    removedItemIds: [],
    submissions: [],
    items: [
      {
        itemId: 'user',
        revision: 0,
        sequence: 1,
        observedAt: 1,
        body: {
          kind: 'message',
          role: 'user',
          blocks: [{ type: 'text', text: 'Review the change' }]
        }
      },
      {
        itemId: 'assistant',
        revision: 0,
        sequence: 2,
        observedAt: 2,
        body: {
          kind: 'message',
          role: 'assistant',
          blocks: [{ type: 'text', text: 'The change is ready for review.' }]
        }
      }
    ],
    window: {
      oldest: { epoch: 'epoch', sequence: 1 },
      newest: { epoch: 'epoch', sequence: 2 },
      nextCursor: { epoch: 'epoch', sequence: 1 }
    },
    liveCursor: { epoch: 'epoch', sequence: 2 },
    hasOlder: false,
    hasNewer: false
  }
  const unsubscribe = vi.fn()
  mocks.call.mockResolvedValue({ ok: true, page })
  mocks.subscribe.mockImplementation(async (_target, _params, emit) => {
    emit({ type: 'snapshot', sessionId: 'chat', page, fence: 1 })
    return { unsubscribe }
  })
  const target = { kind: 'environment', environmentId: 'server-a' } as const
  const observeLink = vi.fn()
  useAppStore.setState({
    observeTerminalGitHubPullRequestLink: observeLink,
    unifiedTabsByWorktree: {
      workspace: [
        {
          id: 'chat-tab',
          entityId: 'chat',
          groupId: 'g',
          worktreeId: 'workspace',
          executionHostId: 'runtime:server-a',
          agentSessionAgent: 'claude',
          contentType: 'agent-session',
          label: 'Chat',
          customLabel: null,
          color: null,
          sortOrder: 0,
          createdAt: 0
        }
      ]
    }
  })
  const { unmount } = render(
    <TooltipProvider>
      <AgentChatPreview session={{ sessionId: 'chat', target }} agentName="Claude" />
    </TooltipProvider>
  )
  await waitFor(() =>
    expect(screen.getByText('The change is ready for review.')).toBeInTheDocument()
  )
  expect(screen.getByText('Review the change')).toBeInTheDocument()
  expect(mocks.call.mock.calls.map(([actualTarget, method]) => [actualTarget, method])).toEqual([
    [target, 'agentSession.history']
  ])
  expect(mocks.subscribe.mock.calls[0]?.[0]).toEqual(target)
  expect(mocks.subscribe.mock.calls[0]?.[1]).toMatchObject({ sessionId: 'chat' })
  expect(mocks.read).not.toHaveBeenCalled()
  const emit = mocks.subscribe.mock.calls[0]![2]
  const publishLink = async (sequence: number): Promise<void> => {
    await act(async () => {
      emit({
        type: 'batch',
        sessionId: 'chat',
        batch: {
          cursor: { epoch: 'epoch', sequence },
          removedItemIds: [],
          submissions: [],
          items: [
            {
              itemId: `tool-${sequence}`,
              sequence,
              revision: 0,
              observedAt: sequence,
              body: {
                kind: 'tool-call',
                name: 'Bash',
                input: { command: 'gh pr create' },
                state: 'completed',
                output: {
                  head: `https://github.com/example/repo/pull/${sequence}`,
                  byteLength: 50,
                  digest: 'demo',
                  truncated: false
                }
              }
            }
          ]
        }
      })
      await vi.advanceTimersByTimeAsync(250)
    })
  }
  vi.useFakeTimers()
  await publishLink(3)
  expect(observeLink).not.toHaveBeenCalled()
  const releaseChat = getStructuredAgentSessionReadOwner('chat', target).activate({
    getState: useAppStore.getState,
    subscribeRetryNow: () => () => {}
  })
  await publishLink(4)
  expect(observeLink).toHaveBeenCalled()
  releaseChat()
  vi.useRealTimers()
  unmount()
  expect(unsubscribe).toHaveBeenCalled()
})
