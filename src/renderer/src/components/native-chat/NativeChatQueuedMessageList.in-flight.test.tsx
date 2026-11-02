// @vitest-environment happy-dom

// A queue action still on its way to the host greys its controls until the host answers.

import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, expect, it, vi } from 'vitest'

vi.mock('sonner', () => ({ toast: { error: vi.fn() } }))
// A card's sender line opens and names agents through modules this test does not exercise.
vi.mock('@/lib/open-agent-message-sender', () => ({ openAgentMessageSender: vi.fn() }))
vi.mock('@/runtime/structured-conversation-name', () => ({
  useStructuredChatTabConversationName: () => null
}))
vi.mock('../../store', () => {
  const state = { updateSettings: vi.fn() }
  const useAppStore = (selector: (value: typeof state) => unknown): unknown => selector(state)
  useAppStore.getState = () => state
  return { useAppStore }
})

import { toast } from 'sonner'
import { TooltipProvider } from '@/components/ui/tooltip'
import { NativeChatQueuedMessageList } from './NativeChatQueuedMessageList'
import { useStructuredAgentSessionQueuedMessages } from './use-structured-agent-session-queued-messages'
import type {
  StructuredAgentSessionMutate,
  StructuredAgentSessionWrite
} from './use-structured-agent-session-mutate'
import type { AgentSessionQueuedMessage } from '../../../../shared/agent-session-wire'

function waitingDraft(messageId: string, position: number): AgentSessionQueuedMessage {
  return {
    messageId,
    position,
    body: { kind: 'message', role: 'user', blocks: [{ type: 'text', text: `${messageId} text` }] },
    state: 'waiting'
  }
}

/** The list over the real controller, held after a Stop, deleting through `write`. */
function renderHeldQueue(
  queuedMessages: AgentSessionQueuedMessage[],
  write: StructuredAgentSessionWrite,
  mutate = vi.fn(async (..._call: [string, string, Record<string, unknown>]) => null)
): void {
  function HeldQueue(): React.JSX.Element {
    const owner = useStructuredAgentSessionQueuedMessages({
      enabled: true,
      queuedMessages,
      queuePause: { reason: 'stopped' },
      submissions: [],
      hasPendingPrompt: false,
      isWorking: false,
      composerScopeKey: undefined,
      // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: the list only awaits mutate; its answer is never read.
      mutate: mutate as StructuredAgentSessionMutate,
      editTransport: { target: { kind: 'local' }, sessionId: 'session', capable: false, write }
    })
    return <NativeChatQueuedMessageList chatWorktreeId={null} controller={owner} />
  }
  render(
    <TooltipProvider delayDuration={0}>
      <HeldQueue />
    </TooltipProvider>
  )
}

afterEach(cleanup)

it('a slow Clear all greys Clear all, Resume and every card until the host answers', async () => {
  vi.mocked(toast.error).mockClear()
  const answer = Promise.withResolvers<void>()
  const write = vi.fn(async () => {
    await answer.promise
    return {
      kind: 'not-done' as const,
      notice: 'Could not delete',
      failure: { kind: 'failed' as const }
    }
  })
  renderHeldQueue([waitingDraft('a', 1), waitingDraft('b', 2)], write)
  const clearAll = () => screen.getByRole('button', { name: 'Clear all' })
  const controls = () => [
    clearAll(),
    screen.getByRole('button', { name: 'Resume' }),
    ...screen.getAllByRole('button', { name: /^(Delete|Steer|Send|More actions)$/ })
  ]
  fireEvent.click(clearAll())
  fireEvent.click(clearAll())
  await waitFor(() =>
    controls().forEach((control) => expect(control).toHaveProperty('disabled', true))
  )
  expect(write).toHaveBeenCalledTimes(2)
  answer.resolve()
  await waitFor(() =>
    controls().forEach((control) => expect(control).toHaveProperty('disabled', false))
  )
  expect(screen.getAllByRole('listitem')).toHaveLength(2)
  expect(toast.error).toHaveBeenCalledExactlyOnceWith('Could not delete')
})

it('Clear all waits out a card Delete on its way, then deletes every card', async () => {
  const deleted = Promise.withResolvers<null>()
  const mutate = vi.fn(
    async (..._call: [string, string, Record<string, unknown>]) => await deleted.promise
  )
  // Only what Clear asks to delete matters here; its answer never comes.
  const write = vi.fn(
    (..._call: [string, string, Record<string, unknown>]) => new Promise<never>(() => {})
  )
  renderHeldQueue([waitingDraft('a', 1), waitingDraft('b', 2)], write, mutate)
  const clearAll = () => screen.getByRole('button', { name: 'Clear all' })
  fireEvent.click(screen.getAllByRole('button', { name: 'Delete' })[0])
  await waitFor(() => expect(clearAll()).toHaveProperty('disabled', true))
  // The Delete failed: its card stays, and Clear all takes it with the rest.
  deleted.resolve(null)
  await waitFor(() => expect(clearAll()).toHaveProperty('disabled', false))
  fireEvent.click(clearAll())
  await waitFor(() => expect(write).toHaveBeenCalledTimes(2))
  expect(write.mock.calls.map((call) => call[2])).toEqual([{ messageId: 'a' }, { messageId: 'b' }])
})
