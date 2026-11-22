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
