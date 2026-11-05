// @vitest-environment happy-dom
import '@testing-library/jest-dom/vitest'
import { act, cleanup, screen } from '@testing-library/react'
import { afterEach, describe, expect, it } from 'vitest'
import { i18n } from '@/i18n/i18n'
import { NativeChatMessageTimestamp } from './NativeChatMessageTimestamp'
import { render } from './native-chat-tooltip-test-harness'

afterEach(async () => {
  cleanup()
  await i18n.changeLanguage('en')
})

describe('NativeChatMessageTimestamp', () => {
  it('updates settled time when the UI language changes without a parent rerender', async () => {
    const timestamp = Date.parse('2026-09-06T19:04:05Z')
    render(<NativeChatMessageTimestamp timestamp={timestamp} />)
    await act(async () => {
      await i18n.changeLanguage('fr')
    })
    const time = screen.getByRole('time')
    expect(time).toHaveTextContent(
      new Intl.DateTimeFormat('fr', { hour: 'numeric', minute: '2-digit' }).format(timestamp)
    )
    expect(time).toHaveAccessibleName(
      new Intl.DateTimeFormat('fr', { dateStyle: 'full', timeStyle: 'long' }).format(timestamp)
    )
    expect(time).toHaveAttribute('datetime', new Date(timestamp).toISOString())
  })
})
