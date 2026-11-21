// @vitest-environment happy-dom

import React, { type ComponentProps } from 'react'
import { cleanup, fireEvent, render } from '@testing-library/react'
import { afterEach, expect, it, vi } from 'vitest'
import { NativeChatQueuedMessageCard } from './NativeChatQueuedMessageCard'
import { projectQueuedMessageCards } from '../../../../../shared/agent-session/view/structured-agent-session-queued-cards'
import type { AgentSessionQueuedMessage } from '../../../../../shared/agent-session/requests/agent-session-queued-message-wire'

vi.mock('@/components/ui/button', () => ({
  Button: React.forwardRef<
    HTMLButtonElement,
    ComponentProps<'button'> & { variant?: string; size?: string }
  >(({ variant: _variant, size: _size, ...props }, ref) => <button ref={ref} {...props} />)
}))
vi.mock('@/components/ui/tooltip', () => ({
  Tooltip: ({ children }: React.PropsWithChildren) => children,
  TooltipTrigger: ({ children }: React.PropsWithChildren) => children,
  TooltipContent: () => null
}))

afterEach(cleanup)

function queued(
  messageId: string,
  body: Partial<AgentSessionQueuedMessage['body']>
): AgentSessionQueuedMessage {
  return {
    messageId,
    position: 1,
    state: 'waiting',
    body: { kind: 'message', role: 'user', blocks: [{ type: 'text', text: 'Check CI' }], ...body }
  }
}

function moreActions(message: AgentSessionQueuedMessage): HTMLElement | null {
  const [card] = projectQueuedMessageCards([message], [], { agentWorking: true })
  const view = render(
    <NativeChatQueuedMessageCard
      card={card!}
      chatWorktreeId={null}
      showsSteerShortcut={false}
      agentWorking
      onSteer={() => {}}
      onDelete={() => {}}
      onEdit={() => {}}
    />
  )
  return view.queryByRole('button', { name: 'More actions' })
}

it("offers Edit on the owner's queued message but never on an automation's queued run", () => {
  expect(moreActions(queued('mine', {}))).not.toBeNull()
  cleanup()
  expect(moreActions(queued('run', { origin: 'automation-run' }))).toBeNull()
})

it('lets a queued reply open to its whole quote even when the one-line summary fits', () => {
  const sent =
    '> Replying to the earlier message from Claude:\n> First line.\n> Second line.\n\nWhy?'
  const [card] = projectQueuedMessageCards(
    [queued('reply', { blocks: [{ type: 'text', text: sent }] })],
    [],
    { agentWorking: true }
  )
  const view = render(
    <NativeChatQueuedMessageCard
      card={card!}
      chatWorktreeId={null}
      showsSteerShortcut={false}
      agentWorking
      onSteer={() => {}}
      onDelete={() => {}}
      onEdit={() => {}}
    />
  )
  fireEvent.click(view.getByRole('button', { name: 'Show full message' }))
  expect(view.container.textContent).toContain('Second line.')
  cleanup()
  // A one-line quote is all in the summary already, so there is nothing more to open.
  const [short] = projectQueuedMessageCards(
    [queued('short', { blocks: [{ type: 'text', text: sent.replace('\n> Second line.', '') }] })],
    [],
    { agentWorking: true }
  )
  const shortView = render(
    <NativeChatQueuedMessageCard
      card={short!}
      chatWorktreeId={null}
      showsSteerShortcut={false}
      agentWorking
      onSteer={() => {}}
      onDelete={() => {}}
      onEdit={() => {}}
    />
  )
  expect(shortView.queryByRole('button', { name: 'Show full message' })).toBeNull()
})
