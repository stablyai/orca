// @vitest-environment happy-dom
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, expect, it, vi } from 'vitest'
import { SessionLinkAddParticipants } from './SessionLinkAddParticipants'
import { source, partner } from './session-link-ui.test-fixture'
import { SessionLinkParticipant } from '../../../../shared/session-link'

vi.mock('@/i18n/i18n', () => ({ translate: (_: string, fallback: string) => fallback }))
afterEach(cleanup)

it('selects several existing chats and submits their IDs without changing the story', async () => {
  const gemini = SessionLinkParticipant.parse({
    ...source,
    sessionId: 'gemini-checkout',
    conversationId: 'gemini-checkout',
    agent: 'gemini',
    name: 'Gemini checks'
  })
  const add = vi.fn(async () => true)
  render(<SessionLinkAddParticipants candidates={[partner, gemini]} busy={false} onAdd={add} />)
  fireEvent.click(screen.getByRole('button', { name: 'Add agents' }))
  fireEvent.click(screen.getByText(partner.name))
  fireEvent.click(screen.getByText(gemini.name))
  fireEvent.click(screen.getByRole('button', { name: 'Add selected agents' }))
  await waitFor(() =>
    expect(add).toHaveBeenCalledExactlyOnceWith([partner.sessionId, gemini.sessionId])
  )
  await waitFor(() => expect(screen.queryByRole('combobox')).toBeNull())
})

it('holds a disappeared or unconfirmed selection instead of adding a different chat', () => {
  const add = vi.fn(async () => false)
  const view = render(
    <SessionLinkAddParticipants
      candidates={[partner]}
      initialSessionId={partner.sessionId}
      busy={false}
      onAdd={add}
    />
  )
  view.rerender(
    <SessionLinkAddParticipants
      candidates={[source]}
      initialSessionId={partner.sessionId}
      busy={false}
      onAdd={add}
    />
  )
  expect(screen.getByRole('button', { name: 'Add selected agents' }).hasAttribute('disabled')).toBe(
    true
  )
  expect(add).not.toHaveBeenCalled()
})
