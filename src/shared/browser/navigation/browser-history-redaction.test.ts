import { expect, it } from 'vitest'
import { redactBrowserHistorySnapshot } from './browser-history-redaction'

it('drops opaque Kagi restore state even after its visible address lost the token', () => {
  expect(
    redactBrowserHistorySnapshot([
      {
        url: 'https://kagi.com/search?q=one',
        title: 'Results',
        pageState: 'opaque-old-token-state'
      },
      {
        url: 'https://www.kagi.com/search?q=two&token=history-secret',
        title: 'Results',
        pageState: 'opaque-token-state'
      }
    ])
  ).toEqual([
    { url: 'https://kagi.com/search?q=one', title: 'Results' },
    { url: 'https://www.kagi.com/search?q=two', title: 'Results' }
  ])
})

it('keeps ordinary entries’ scroll and form state beside a private Kagi entry', () => {
  expect(
    redactBrowserHistorySnapshot([
      { url: 'https://example.com/', title: 'Home', pageState: 'home-scroll-state' },
      {
        url: 'https://kagi.com/search?q=one&token=history-secret',
        title: 'Results',
        pageState: 'opaque-token-state'
      },
      { url: 'https://example.com/form', title: 'Form', pageState: 'typed-form-state' }
    ])
  ).toEqual([
    { url: 'https://example.com/', title: 'Home', pageState: 'home-scroll-state' },
    { url: 'https://kagi.com/search?q=one', title: 'Results' },
    { url: 'https://example.com/form', title: 'Form', pageState: 'typed-form-state' }
  ])
  expect(
    redactBrowserHistorySnapshot([
      { url: 'https://example.com/', title: 'Home', pageState: 'ordinary-scroll-state' }
    ])
  ).toEqual([{ url: 'https://example.com/', title: 'Home', pageState: 'ordinary-scroll-state' }])
})
