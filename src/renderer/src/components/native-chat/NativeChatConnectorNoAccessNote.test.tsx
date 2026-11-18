// @vitest-environment happy-dom
import '@testing-library/jest-dom/vitest'
import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, describe, expect, it } from 'vitest'
import { NativeChatConnectorNoAccessNote } from './NativeChatConnectorNoAccessNote'

const ASKER = {
  source: 'slack' as const,
  userId: 'U0SAM',
  name: 'Sam Lee',
  role: 'member' as const,
  place: { kind: 'public_channel' as const, id: 'C9' },
  noAccess: [{ name: 'Alex Kim', text: 'Repro: drag the divider fast.' }, { text: 'Only on main.' }]
}

afterEach(cleanup)

describe('NativeChatConnectorNoAccessNote', () => {
  it('starts collapsed under one note, and opens to each line marked as no access', () => {
    render(<NativeChatConnectorNoAccessNote messageId="m1" asker={ASKER} />)
    const note = screen.getByRole('button', { name: /2 earlier messages in the thread/ })
    expect(note).toHaveAttribute('aria-expanded', 'false')
    expect(screen.queryByText('Repro: drag the divider fast.')).toBeNull()

    fireEvent.click(note)
    expect(note).toHaveAttribute('aria-expanded', 'true')
    expect(screen.getByText('Repro: drag the divider fast.')).toBeInTheDocument()
    expect(screen.getByTitle('Alex Kim · Slack · no access')).toHaveTextContent(
      'AKAlex Kim·Slack·no access'
    )
    expect(screen.getByTitle('Someone · Slack · no access')).toBeInTheDocument()
  })
})
