// @vitest-environment happy-dom
import '@testing-library/jest-dom/vitest'
import { cleanup, render, screen } from '@testing-library/react'
import { afterEach, describe, expect, it } from 'vitest'
import {
  createStructuredAgentSessionOutboxEntry,
  type StructuredAgentSessionOutboxEntry
} from '../../../../shared/structured-agent-session-outbox'
import { NativeChatDeliveryRetry } from './NativeChatDeliveryRetry'

const blocked = createStructuredAgentSessionOutboxEntry({
  clientMessageId: 'client-1',
  sessionId: 'session-1',
  text: 'hello',
  attachments: [],
  queuedAt: 1
})

function renderRow(entry: StructuredAgentSessionOutboxEntry): void {
  render(
    <NativeChatDeliveryRetry
      outbox={[entry]}
      blockedClientMessageId={entry.clientMessageId}
      retry={() => {}}
    />
  )
}

afterEach(cleanup)

describe("the Retry row's reason", () => {
  it('chooses its words from the saved failure when it is shown', () => {
    renderRow({ ...blocked, lastFailure: { kind: 'refused', code: 'agent_session_conflict' } })

    expect(
      screen.getByText(
        "Orca couldn't confirm which agent process owns this chat. Your message was not sent. Retry to send it again."
      )
    ).toBeInTheDocument()
  })

  it("shows a provider's rejection in the provider's words", () => {
    renderRow({
      ...blocked,
      lastFailure: { kind: 'rejected', reason: 'Claude messages support at most 20 images' }
    })

    expect(screen.getByText('Claude messages support at most 20 images')).toBeInTheDocument()
  })

  it('says only that the message was not sent when nothing more is known', () => {
    renderRow(blocked)

    expect(screen.getByText('Message was not sent.')).toBeInTheDocument()
  })
})
