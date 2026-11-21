// @vitest-environment happy-dom

import React, { type ComponentProps } from 'react'
import { cleanup, render } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
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

afterEach(() => {
  cleanup()
  vi.restoreAllMocks()
})

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

function renderQueuedMessage(message: AgentSessionQueuedMessage): ReturnType<typeof render> {
  const [card] = projectQueuedMessageCards([message], [], { agentWorking: true })
  return render(
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
}

it("offers Edit on the owner's queued message but never on an automation's queued run", () => {
  expect(
    renderQueuedMessage(queued('mine', {})).queryByRole('button', { name: 'More actions' })
  ).not.toBeNull()
  cleanup()
  expect(
    renderQueuedMessage(queued('run', { origin: 'automation-run' })).queryByRole('button', {
      name: 'More actions'
    })
  ).toBeNull()
})

it('tabs through queued message actions before expanding the message with the keyboard', async () => {
  vi.spyOn(HTMLElement.prototype, 'clientWidth', 'get').mockReturnValue(480)
  vi.spyOn(HTMLElement.prototype, 'scrollWidth', 'get').mockReturnValue(960)
  const user = userEvent.setup()
  const view = renderQueuedMessage(queued('clipped', {}))

  for (const name of ['Steer', 'Delete', 'More actions', 'Show full message']) {
    await user.tab()
    expect(document.activeElement).toBe(view.getByRole('button', { name }))
  }

  await user.keyboard('{Enter}')
  expect(document.activeElement).toBe(
    view.getByRole('button', { name: 'Show less', expanded: true })
  )
})
