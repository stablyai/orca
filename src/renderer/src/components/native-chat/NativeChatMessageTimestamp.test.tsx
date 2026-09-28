// @vitest-environment happy-dom
import '@testing-library/jest-dom/vitest'
import { act, cleanup, render, screen } from '@testing-library/react'
import { afterEach, describe, expect, it } from 'vitest'
import { i18n } from '@/i18n/i18n'
import { NativeChatMessageTimestamp } from './NativeChatMessageTimestamp'

afterEach(async () => {
  cleanup()
  await i18n.changeLanguage('en')
})

describe('NativeChatMessageTimestamp', () => {
  it.each([null, Number.NaN, Infinity, -Infinity, 8.64e15 + 1])(
    'omits missing or invalid time %s',
    (timestamp) => {
      const { container } = render(<NativeChatMessageTimestamp timestamp={timestamp} focusable />)
      expect(container).toBeEmptyDOMElement()
    }
  )

  it.each([0, Date.parse('2026-09-06T19:04:05Z')])(
    'renders absolute time and full metadata for %s',
    (timestamp) => {
      render(<NativeChatMessageTimestamp timestamp={timestamp} />)
      const time = screen.getByRole('time')
      expect(time).toHaveAttribute('datetime', new Date(timestamp).toISOString())
      expect(time).toHaveTextContent(
        new Intl.DateTimeFormat('en', { hour: 'numeric', minute: '2-digit' }).format(timestamp)
      )
      expect(time).toHaveAccessibleName(
        new Intl.DateTimeFormat('en', { dateStyle: 'full', timeStyle: 'long' }).format(timestamp)
      )
      expect(time).not.toHaveAttribute('tabindex')
    }
  )

  it('provides a focus target only when requested for user metadata', () => {
    render(<NativeChatMessageTimestamp timestamp={0} focusable />)
    const time = screen.getByRole('time')
    time.focus()
    expect(time).toHaveFocus()
    expect(time).toHaveAttribute('tabindex', '0')
  })

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
