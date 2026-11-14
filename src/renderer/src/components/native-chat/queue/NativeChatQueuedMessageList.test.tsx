// @vitest-environment happy-dom

import React from 'react'
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, expect, it, vi } from 'vitest'
import { TooltipProvider } from '@/components/ui/tooltip'
import { NativeChatQueuedMessageList } from './NativeChatQueuedMessageList'
import type { StructuredAgentSessionQueuedMessagesController } from './use-structured-agent-session-queued-messages'
import type { QueuedMessageCard } from '../../../../../shared/agent-session/view/structured-agent-session-queued-cards'
import { QUEUED_MESSAGE_PAUSED_SEND_FAILED } from '../../../../../shared/agent-session/requests/agent-session-queued-message-wire'

// The ⋯ menu portals in the app; inline here so its items can be pressed.
vi.mock('@/components/ui/dropdown-menu', () => ({
  DropdownMenu: ({ children }: React.PropsWithChildren) => <div>{children}</div>,
  DropdownMenuTrigger: ({ children }: React.PropsWithChildren) => children,
  DropdownMenuContent: ({ children }: React.PropsWithChildren) => <div role="menu">{children}</div>,
  DropdownMenuItem: ({
    children,
    onSelect,
    disabled
  }: React.PropsWithChildren<{ onSelect?: () => void; disabled?: boolean }>) => (
    <button type="button" role="menuitem" disabled={disabled} onClick={() => onSelect?.()}>
      {children}
    </button>
  )
}))

afterEach(() => {
  cleanup()
  vi.restoreAllMocks()
})

const card = (index: number, extra: Partial<QueuedMessageCard> = {}): QueuedMessageCard => ({
  messageId: `m${index}`,
  position: index,
  text: `Queued message ${index}`,
  state: 'waiting',
  hold: 'turn',
  ...extra
})

function controller(
  cards: QueuedMessageCard[],
  extra: Partial<StructuredAgentSessionQueuedMessagesController> = {}
): StructuredAgentSessionQueuedMessagesController {
  return {
    cards,
    queueCapable: true,
    clearCapable: true,
    pause: null,
    resume: vi.fn(async () => true),
    clear: vi.fn(async () => true),
    queuePending: null,
    pending: () => null,
    steer: vi.fn(async () => {}),
    remove: vi.fn(async () => {}),
    editCapable: true,
    editor: undefined,
    edit: vi.fn(async () => {}),
    steerHead: undefined,
    isWorking: false,
    ...extra
  }
}

function renderQueue(
  queue: StructuredAgentSessionQueuedMessagesController,
  { questionOpen = false }: { questionOpen?: boolean } = {}
): void {
  render(
    <TooltipProvider>
      <div data-native-chat-root="true">
        <div data-native-chat-dock="">
          <NativeChatQueuedMessageList controller={queue} chatWorktreeId={null} />
          {questionOpen ? <div data-native-chat-question-card="" /> : null}
        </div>
      </div>
    </TooltipProvider>
  )
}

it("shows a send-failed card as Couldn't send with Retry, which sends it again", () => {
  const queue = controller([
    card(1),
    card(2, { hold: 'paused', pausedReason: QUEUED_MESSAGE_PAUSED_SEND_FAILED })
  ])
  renderQueue(queue)
  expect(screen.getByText("Couldn't send")).toBeTruthy()
  fireEvent.click(screen.getByRole('button', { name: 'Retry' }))
  expect(queue.steer).toHaveBeenCalledWith('m2')
  // The healthy card keeps its Send.
  expect(screen.getAllByRole('button', { name: 'Send' })).toHaveLength(1)
})

it('offers Edit, Show full message and Delete from ⋯, with the hover-only Delete still reachable', () => {
  const queue = controller([card(1)])
  renderQueue(queue)
  const message = screen.getByRole('button', { name: 'Queued message 1' })
  expect(message.getAttribute('aria-expanded')).toBe('false')
  fireEvent.click(screen.getByRole('menuitem', { name: 'Show full message' }))
  expect(
    screen.getByText('Queued message 1').closest('button')!.getAttribute('aria-expanded')
  ).toBe('true')
  fireEvent.click(screen.getByRole('menuitem', { name: 'Show less' }))
  fireEvent.click(screen.getByRole('menuitem', { name: 'Edit message' }))
  expect(queue.edit).toHaveBeenCalledWith('m1')
  fireEvent.click(screen.getByRole('menuitem', { name: 'Delete' }))
  expect(queue.remove).toHaveBeenCalledTimes(1)
  // Delete outside the menu shows on hover or focus, but is always in the tab order.
  const remove = screen.getByRole('button', { name: 'Delete' })
  expect(remove.hasAttribute('disabled')).toBe(false)
  act(() => remove.focus())
  expect(document.activeElement).toBe(remove)
  fireEvent.click(remove)
  expect(queue.remove).toHaveBeenCalledTimes(2)
})

it('shows three rows under an open question with a +N more row that opens the rest', () => {
  renderQueue(controller([1, 2, 3, 4, 5, 6].map((i) => card(i))), { questionOpen: true })
  const more = screen.getByRole('button', { name: '+3 more' })
  fireEvent.click(more)
  expect(screen.getByRole('button', { name: 'Show less' }).getAttribute('aria-expanded')).toBe(
    'true'
  )
  fireEvent.click(screen.getByRole('button', { name: 'Show less' }))
  expect(screen.getByRole('button', { name: '+3 more' })).toBeTruthy()
})

it('shows one row in a short pane and no +N more when the question is gone and room is normal', () => {
  vi.spyOn(HTMLElement.prototype, 'getBoundingClientRect').mockImplementation(
    () => new DOMRect(0, 0, 0, 4)
  )
  vi.spyOn(HTMLElement.prototype, 'clientHeight', 'get').mockReturnValue(500)
  renderQueue(controller([1, 2, 3, 4, 5, 6].map((i) => card(i))), { questionOpen: true })
  expect(screen.getByRole('button', { name: '+5 more' })).toBeTruthy()
  cleanup()
  vi.restoreAllMocks()
  renderQueue(controller([1, 2, 3, 4, 5, 6].map((i) => card(i))))
  expect(screen.queryByRole('button', { name: /more$/ })).toBeNull()
})
