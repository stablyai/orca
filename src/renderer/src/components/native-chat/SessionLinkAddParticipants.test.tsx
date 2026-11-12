// @vitest-environment happy-dom
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, expect, it, vi } from 'vitest'
import { SessionLinkAddParticipants } from './SessionLinkAddParticipants'
import { source, partner } from './session-link-ui.test-fixture'
import { SessionLinkParticipant } from '../../../../shared/session-link'
import { TranslationScopeContext, type Translate } from '@/i18n/use-translate'

vi.mock('@/i18n/i18n', () => ({ translate: (_: string, fallback: string) => fallback }))
afterEach(cleanup)

const english: Translate = (key, fallback) => (typeof fallback === 'string' ? fallback : key)
const russian: Translate = (key, fallback) =>
  key === 'components.sessionLink.addSelected'
    ? 'Добавить выбранных агентов'
    : english(key, fallback)
const englishScope = { t: english, intlLocale: 'en' }
const russianScope = { t: russian, intlLocale: 'ru' }

it('updates translated controls without losing the selected participant', async () => {
  const add = vi.fn(async () => true)
  const card = (
    <SessionLinkAddParticipants
      candidates={[partner]}
      initialSessionId={partner.sessionId}
      busy={false}
      onAdd={add}
    />
  )
  const view = render(
    <TranslationScopeContext.Provider value={englishScope}>{card}</TranslationScopeContext.Provider>
  )
  expect(screen.getByRole('button', { name: 'Add selected agents' })).toBeTruthy()
  view.rerender(
    <TranslationScopeContext.Provider value={russianScope}>{card}</TranslationScopeContext.Provider>
  )
  fireEvent.click(screen.getByRole('button', { name: 'Добавить выбранных агентов' }))
  await waitFor(() => expect(add).toHaveBeenCalledExactlyOnceWith([partner.sessionId]))
})

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
