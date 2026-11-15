import { expect, it } from 'vitest'
import { redactBrowserHistorySnapshot } from './browser-history-redaction'

it('drops opaque Kagi restore state even after its visible address lost the token', () => {
  expect(
    redactBrowserHistorySnapshot([
      { url: 'https://example.com/', title: 'Home', pageState: 'opaque-referrer-state' },
      {
        url: 'https://kagi.com/search?q=one',
        title: 'Results',
        pageState: 'opaque-old-token-state'
      }
    ])
  ).toEqual([
    { url: 'https://example.com/', title: 'Home' },
    { url: 'https://kagi.com/search?q=one', title: 'Results' }
  ])
  expect(
    redactBrowserHistorySnapshot([
      { url: 'https://example.com/', title: 'Home', pageState: 'ordinary-scroll-state' }
    ])
  ).toEqual([{ url: 'https://example.com/', title: 'Home', pageState: 'ordinary-scroll-state' }])
})
