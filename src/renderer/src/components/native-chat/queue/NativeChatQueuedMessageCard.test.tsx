// @vitest-environment happy-dom

import React, { type ComponentProps } from 'react'
import { cleanup, render } from '@testing-library/react'
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

function renderCard(message: AgentSessionQueuedMessage, onEdit = vi.fn()) {
  const [card] = projectQueuedMessageCards([message], [], { agentWorking: true })
  const view = render(
    <NativeChatQueuedMessageCard
      card={card!}
      chatWorktreeId={null}
      showsSteerShortcut={false}
      agentWorking
      onSteer={() => {}}
      onDelete={() => {}}
      onEdit={onEdit}
    />
  )
  return view.queryByRole('button', { name: 'Edit message' })
}

it("edits the owner's queued message in one press, without a menu", () => {
  const onEdit = vi.fn()
  renderCard(queued('mine', {}), onEdit)?.click()
  expect(onEdit).toHaveBeenCalledTimes(1)
})

it("never offers Edit on an automation's queued run", () => {
  expect(renderCard(queued('run', { origin: 'automation-run' }))).toBeNull()
})
