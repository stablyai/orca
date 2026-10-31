// @vitest-environment happy-dom

import { cleanup, fireEvent, render, screen, within } from '@testing-library/react'
import { afterEach, expect, it, vi } from 'vitest'

const mocks = vi.hoisted(() => ({
  updateSettings: vi.fn()
}))

vi.mock('sonner', () => ({ toast: { error: vi.fn() } }))
// A card's sender line opens and names agents through modules this test does not exercise.
vi.mock('@/lib/open-agent-message-sender', () => ({ openAgentMessageSender: vi.fn() }))
vi.mock('@/runtime/structured-conversation-name', () => ({
  useStructuredChatTabConversationName: () => null
}))
vi.mock('../../store', () => {
  const state = { updateSettings: mocks.updateSettings }
  const useAppStore = (selector: (value: typeof state) => unknown): unknown => selector(state)
  useAppStore.getState = () => state
  return { useAppStore }
})

import { TooltipProvider } from '@/components/ui/tooltip'
import {
  projectQueuedMessageCards,
  queuedMessagesQueuePause,
  type QueuedMessageCard
} from '../../../../shared/structured-agent-session-queued-cards'
import { NativeChatQueuedMessageList } from './NativeChatQueuedMessageList'
import type { StructuredAgentSessionQueuedMessagesController } from './use-structured-agent-session-queued-messages'
import type { AgentSessionQueuedMessage } from '../../../../shared/agent-session-wire'
import type { AgentSessionFailureFact } from '../../../../shared/agent-session-failure'

function renderList(
  owner: StructuredAgentSessionQueuedMessagesController,
  agentName?: string,
  statedFailures?: readonly AgentSessionFailureFact[]
) {
  return render(
    <TooltipProvider delayDuration={0}>
      <NativeChatQueuedMessageList
        chatWorktreeId={null}
        controller={owner}
        agentName={agentName}
        statedFailures={statedFailures}
      />
    </TooltipProvider>
  )
}

function controller(
  cards: QueuedMessageCard[],
  pause: { reason: string } | null = null,
  queueCapable = true
): StructuredAgentSessionQueuedMessagesController & {
  steer: ReturnType<typeof vi.fn>
  remove: ReturnType<typeof vi.fn>
  edit: ReturnType<typeof vi.fn>
  resume: ReturnType<typeof vi.fn>
  clear: ReturnType<typeof vi.fn>
} {
  return {
    cards,
    queueCapable,
    clearCapable: cards.every((entry) => entry.hold !== 'sending'),
    editCapable: true,
    editor: undefined,
    pause,
    resume: vi.fn(async () => false),
    clear: vi.fn(async () => true),
    queuePending: null,
    pending: () => null,
    steer: vi.fn(async () => {}),
    remove: vi.fn(async () => {}),
    edit: vi.fn(async () => {}),
    steerNewest: vi.fn(() => false)
  }
}

afterEach(cleanup)

it('omits saved uncertainty words while keeping the full returned card, barrier and actions', async () => {
  const saved: AgentSessionQueuedMessage = {
    messageId: 'saved',
    position: 1,
    state: 'returned',
    returnedReason: "Couldn't confirm whether this was sent. It hasn't been resent.",
    returnedRejection: { kind: 'unconfirmed' },
    body: {
      kind: 'message',
      role: 'user',
      blocks: [
        { type: 'text', text: 'Original full prose before the image.' },
        { type: 'image-ref', path: '/tmp/saved.png' },
        { type: 'text', text: 'Original full prose after the image.' }
      ]
    }
  }
  const original = structuredClone(saved)
  const cards = projectQueuedMessageCards(
    [saved, { ...saved, messageId: 'later', position: 2, state: 'waiting' }],
    [],
    {}
  )
  const pause = queuedMessagesQueuePause(cards, { reason: 'stopped' })
  expect(
    cards.map(({ messageId, hold, resumeEligible }) => ({ messageId, hold, resumeEligible }))
  ).toEqual([
    { messageId: 'saved', hold: 'returned', resumeEligible: undefined },
    { messageId: 'later', hold: 'behind-returned', resumeEligible: undefined }
  ])
  expect(pause).toBeNull()
  const owner = controller(cards, pause)
  renderList(owner, 'Claude', [{ kind: 'unconfirmed' }])
  const row = screen.getAllByRole('listitem')[0]!
  expect(row.dataset.queuedMessageId).toBe('saved')
  expect(row.dataset.queuedMessageState).toBe('returned')
  expect(row.textContent).toContain('Original full prose before the image.')
  expect(row.textContent).toContain('Original full prose after the image.')
  expect(cards[0]?.images).toEqual([{ type: 'image-ref', path: '/tmp/saved.png' }])
  expect(row.textContent).not.toContain('confirm')
  expect(row.textContent).not.toContain('not sent')
  expect(screen.queryByRole('button', { name: 'Resume' })).toBeNull()
  fireEvent.click(within(row).getByRole('button', { name: 'Send' }))
  fireEvent.click(within(row).getByRole('button', { name: 'Delete' }))
  fireEvent.pointerDown(within(row).getByRole('button', { name: 'More actions' }))
  fireEvent.click(await screen.findByRole('menuitem', { name: 'Edit message' }))
  expect(owner.steer).toHaveBeenCalledExactlyOnceWith('saved')
  expect(owner.remove).toHaveBeenCalledExactlyOnceWith('saved')
  expect(owner.edit).toHaveBeenCalledExactlyOnceWith('saved')
  expect(saved).toEqual(original)
})
