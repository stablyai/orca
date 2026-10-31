// @vitest-environment happy-dom
import '@testing-library/jest-dom/vitest'
import { cleanup, render, screen } from '@testing-library/react'
import { afterEach, expect, it, vi } from 'vitest'
import { projectStructuredItemsToNativeChat } from '../../../../shared/structured-agent-session-projection'
import { agentSessionAccountSwitchBody } from '../../../../shared/agent-session-account-switch-row'
import { isAdmissibleAgentJournalItemBody } from '../../../../shared/agent-session-journal-schemas'
import type { AgentJournalStatusItem } from '../../../../shared/agent-session-journal-types'
import { TooltipProvider } from '@/components/ui/tooltip'
import { MessageRow } from './NativeChatMessageRow'

afterEach(() => {
  cleanup()
})

function renderRow(body: AgentJournalStatusItem) {
  const [message] = projectStructuredItemsToNativeChat([
    {
      itemId: 'switch',
      sequence: 1,
      revision: 1,
      observedAt: 1,
      body,
      turnScope: { kind: 'thread' }
    }
  ])
  return render(
    <TooltipProvider>
      <MessageRow message={message!} expandSignal={false} onScrollMessageToTop={vi.fn()} />
    </TooltipProvider>
  )
}

it('records the move to the selected account as one quiet line', () => {
  const body = agentSessionAccountSwitchBody('b@example.com')
  expect(isAdmissibleAgentJournalItemBody(body)).toBe(true)
  renderRow(body)
  const line = screen.getByText('Now on b@example.com · same conversation')
  expect(line).toHaveClass('text-chat-foreground-faint')
  expect(screen.queryByRole('img')).toBeNull()
})

it('names System default when the selected account is the user’s own login', () => {
  renderRow(agentSessionAccountSwitchBody(undefined))
  expect(screen.getByText('Now on System default · same conversation')).toBeInTheDocument()
})
