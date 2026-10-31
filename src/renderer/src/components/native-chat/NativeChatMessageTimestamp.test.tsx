// @vitest-environment happy-dom
import '@testing-library/jest-dom/vitest'
import { act, cleanup, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { afterEach, describe, expect, it } from 'vitest'
import { i18n } from '@/i18n/i18n'
import { NativeChatMessageTimestamp } from './NativeChatMessageTimestamp'
import { render } from './native-chat-tooltip-test-harness'

const fullLabel = (timestamp: number): string =>
  new Intl.DateTimeFormat('en', { dateStyle: 'full', timeStyle: 'long' }).format(timestamp)

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
      expect(time).toHaveAccessibleName(fullLabel(timestamp))
      expect(time).not.toHaveAttribute('tabindex')
    }
  )

  it('shows the full date and time on hover', async () => {
    const timestamp = Date.parse('2026-09-06T19:04:05Z')
    render(<NativeChatMessageTimestamp timestamp={timestamp} />)
    await userEvent.setup().hover(screen.getByRole('time'))
    expect(await screen.findByRole('tooltip')).toHaveTextContent(fullLabel(timestamp))
  })

  it('names a focusable timestamp before focus and shows, not re-announces, the tooltip on focus', async () => {
    const timestamp = Date.parse('2026-09-06T19:04:05Z')
    render(<NativeChatMessageTimestamp timestamp={timestamp} focusable />)
    const time = screen.getByRole('time')
    expect(time).toHaveAccessibleName(fullLabel(timestamp))
    await userEvent.setup().tab()
    expect(time).toHaveFocus()
    expect(await screen.findByRole('tooltip')).toHaveTextContent(fullLabel(timestamp))
    expect(time).not.toHaveAttribute('aria-describedby')
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
