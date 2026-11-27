import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { browserChatMarks, OLD, TAB } from './chat-read-mark-web-test-fixture'

beforeEach(() => {
  vi.spyOn(performance, 'now').mockReturnValue(10_000)
})

afterEach(() => {
  vi.restoreAllMocks()
  vi.unstubAllGlobals()
})

it('skips storage on a miss and stops walking receipts once the index empties', () => {
  const marks = browserChatMarks({ manuallyUnreadTurnsByPaneKey: { [OLD]: 200 } })
  const { receive } = marks.open()
  receive([{ ...TAB, sessionId: 'session-3' }])
  expect(marks.localStorage.getItem).not.toHaveBeenCalled()

  receive([TAB])
  expect(marks.localStorage.getItem).toHaveBeenCalledTimes(1)
  const tabs = [TAB]
  Object.defineProperty(tabs, 0, {
    get: () => {
      throw new Error('Unexpected chat row lookup')
    }
  })
  receive(tabs)
  expect(marks.localStorage.getItem).toHaveBeenCalledTimes(1)
})

it('stops walking receipts at the monotonic page deadline even with pending aliases', () => {
  const marks = browserChatMarks({ manuallyUnreadTurnsByPaneKey: { [OLD]: 200 } })
  const { receive } = marks.open()
  vi.mocked(performance.now).mockReturnValue(120_000)
  const tabs = [TAB]
  Object.defineProperty(tabs, 0, {
    get: () => {
      throw new Error('Unexpected chat row lookup')
    }
  })
  receive(tabs)
  expect(marks.localStorage.getItem).not.toHaveBeenCalled()
})
