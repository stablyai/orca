import { expect, it } from 'vitest'
import { nativeChatPhraseEnd } from './native-chat-phrase-chunks'

it('holds short token arrivals until a word group or punctuation completes', () => {
  expect(nativeChatPhraseEnd('One two three', 0, 13, false)).toBe(0)
  expect(nativeChatPhraseEnd('One two three four five', 0, 19, false)).toBe(19)
  expect(nativeChatPhraseEnd('Reading the PDF. Next step', 0, 20, false)).toBe(16)
  expect(nativeChatPhraseEnd('检查日历，然后安排会议。', 0, 5, false)).toBe(5)
})
it('flushes a paused or completed reply without losing its tail', () => {
  expect(nativeChatPhraseEnd('One two', 0, 7, true)).toBe(7)
  expect(nativeChatPhraseEnd('One two three four five', 19, 22, true)).toBe(22)
})
it('groups only the new suffix and never exposes text beyond the reveal clock', () => {
  expect(nativeChatPhraseEnd('One two three four five six seven eight nine', 19, 44, false)).toBe(
    40
  )
  expect(nativeChatPhraseEnd('One two three four five', 0, 10, false)).toBe(0)
})
