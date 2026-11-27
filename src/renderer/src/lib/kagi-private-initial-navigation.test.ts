import { afterEach, expect, it, vi } from 'vitest'
import {
  discardKagiPrivateInitialNavigation,
  queueKagiPrivateInitialNavigation,
  takeKagiPrivateInitialNavigation
} from './kagi-private-initial-navigation'

afterEach(() => {
  vi.useRealTimers()
})

it.each([
  [
    'https://kagi.com/search?token=test-only&q=hello+world',
    'https://kagi.com/search?q=hello+world'
  ],
  [
    'https://kagi.com/search?q=one&q=two&token=test-only&x=1#results',
    'https://kagi.com/search?q=one&q=two&x=1#results'
  ],
  [
    'https://www.kagi.com/search/?q=%20%2B&token=test-only#two',
    'https://www.kagi.com/search/?q=%20%2B#two'
  ]
])('delivers the original private request once, keeping a safe model: %s', (raw, safe) => {
  queueKagiPrivateInitialNavigation('page', raw)
  expect(takeKagiPrivateInitialNavigation('page', safe)).toBe(raw)
  expect(takeKagiPrivateInitialNavigation('page', safe)).toBe(safe)
})

it('collapses duplicate tokens without losing query or fragment and follows first-token eligibility', () => {
  queueKagiPrivateInitialNavigation(
    'page',
    'https://kagi.com/search?q=one&token=first&token=second&x=1#two'
  )
  expect(takeKagiPrivateInitialNavigation('page', 'https://kagi.com/search?q=one&x=1#two')).toBe(
    'https://kagi.com/search?q=one&token=first&x=1#two'
  )
  queueKagiPrivateInitialNavigation('page', 'https://kagi.com/search?token=&token=second&q=one')
  expect(takeKagiPrivateInitialNavigation('page', 'https://kagi.com/search?q=one')).toBe(
    'https://kagi.com/search?q=one'
  )
})

it('never replays discarded, superseded, expired or evicted requests on a later mount', () => {
  vi.useFakeTimers()
  const raw = 'https://kagi.com/search?token=test-only&q=one'
  const safe = 'https://kagi.com/search?q=one'
  queueKagiPrivateInitialNavigation('closed', raw)
  discardKagiPrivateInitialNavigation('closed')
  expect(takeKagiPrivateInitialNavigation('closed', safe)).toBe(safe)
  queueKagiPrivateInitialNavigation('changed', raw)
  expect(takeKagiPrivateInitialNavigation('changed', 'https://example.com/')).toBe(
    'https://example.com/'
  )
  expect(takeKagiPrivateInitialNavigation('changed', safe)).toBe(safe)
  queueKagiPrivateInitialNavigation('expired', raw)
  vi.advanceTimersByTime(300_001)
  expect(takeKagiPrivateInitialNavigation('expired', safe)).toBe(safe)
  for (let index = 0; index < 129; index++) {
    queueKagiPrivateInitialNavigation(`page-${index}`, raw)
  }
  expect(takeKagiPrivateInitialNavigation('page-0', safe)).toBe(safe)
  expect(takeKagiPrivateInitialNavigation('page-128', safe)).toBe(raw)
  for (let index = 1; index < 128; index++) {
    discardKagiPrivateInitialNavigation(`page-${index}`)
  }
})

it('normalizes an admitted schemeless search and rewrites only duplicate bearer parameters', () => {
  queueKagiPrivateInitialNavigation('schemeless', 'kagi.com/search?q=one&token=test-only')
  expect(takeKagiPrivateInitialNavigation('schemeless', 'https://kagi.com/search?q=one')).toBe(
    'https://kagi.com/search?q=one&token=test-only'
  )
  queueKagiPrivateInitialNavigation(
    'encoded',
    'https://kagi.com/search?q=a%20b&flag&x=~&token=first&token=second#result'
  )
  expect(
    takeKagiPrivateInitialNavigation('encoded', 'https://kagi.com/search?q=a%20b&flag&x=~#result')
  ).toBe('https://kagi.com/search?q=a%20b&flag&x=~&token=first#result')
})
