// @vitest-environment happy-dom
import '@testing-library/jest-dom/vitest'
import { cleanup, render, screen } from '@testing-library/react'
import { afterEach, expect, it } from 'vitest'
import { i18n } from '@/i18n/i18n'
import { NativeChatTurnActivityLine } from './NativeChatTurnActivityLine'

afterEach(async () => {
  cleanup()
  await i18n.changeLanguage('en')
})

it.each(['en', 'fr'])('renders the sleep duration and clears it in %s', async (locale) => {
  await i18n.changeLanguage(locale)
  const line = (activityText: string | null) => ({
    thinking: false,
    stopping: false,
    reasoning: null,
    reasoningExpanded: false,
    activityText
  })
  const { rerender } = render(<NativeChatTurnActivityLine line={line('Waiting for 10m 0s')} />)
  expect(screen.getByText('Waiting for 10m 0s')).toBeVisible()
  rerender(<NativeChatTurnActivityLine line={line(null)} />)
  expect(screen.queryByText('Waiting for 10m 0s')).toBeNull()
  expect(document.querySelector('[data-native-chat-turn-activity]')).toHaveTextContent(
    locale === 'fr' ? 'Fonctionnement…' : 'Working…'
  )
})
