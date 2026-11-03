// @vitest-environment happy-dom
import '@testing-library/jest-dom/vitest'
import { cleanup, render, screen } from '@testing-library/react'
import { afterEach, expect, it } from 'vitest'
import { i18n } from '@/i18n/i18n'
import { codexProviderFrameActivity } from '../../../../main/native-chat/agent-session-wire/provider-frame-activity'
import { NativeChatTurnActivityLine } from './NativeChatTurnActivityLine'

afterEach(async () => {
  cleanup()
  await i18n.changeLanguage('en')
})

it.each(['en', 'fr'])('renders the sleep duration and clears it in %s', async (locale) => {
  await i18n.changeLanguage(locale)
  const item = { type: 'sleep', id: 'sleep-1', durationMs: 600_000 }
  const line = (method: string) => ({
    thinking: false,
    reasoning: null,
    reasoningExpanded: false,
    activityText: codexProviderFrameActivity(method, { item }) ?? null
  })
  const { rerender } = render(<NativeChatTurnActivityLine line={line('item/started')} />)
  expect(screen.getByText('Waiting for 10m 0s')).toBeVisible()
  rerender(<NativeChatTurnActivityLine line={line('item/completed')} />)
  expect(screen.queryByText('Waiting for 10m 0s')).toBeNull()
  expect(document.querySelector('[data-native-chat-turn-activity]')).toHaveTextContent(
    locale === 'fr' ? 'Fonctionnement…' : 'Working…'
  )
})
