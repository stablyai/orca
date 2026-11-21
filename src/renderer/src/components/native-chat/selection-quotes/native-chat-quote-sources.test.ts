// @vitest-environment happy-dom
import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  jumpToQuoteSource,
  nativeChatQuoteSource,
  quotedFileLocation,
  rememberNativeChatQuoteSource
} from './native-chat-quote-sources'

afterEach(() => localStorage.clear())

const place = { offset: 4, length: 6, hash: 'h' }
const source = (messageId: string) => ({ messageId, place })

describe('quote sources', () => {
  it('finds the source of a quote by its text, line ends and trailing spaces aside', () => {
    rememberNativeChatQuoteSource('  first line  \r\nsecond line\n', source('reply-1'))
    expect(nativeChatQuoteSource('first line\nsecond line')).toEqual(source('reply-1'))
    expect(nativeChatQuoteSource('first line second line')).toBeNull()
    expect(nativeChatQuoteSource('other text')).toBeNull()
  })

  it('keeps quotes that differ only in symbols apart', () => {
    rememberNativeChatQuoteSource('x & y', source('m1'))
    rememberNativeChatQuoteSource('x y', source('m2'))
    rememberNativeChatQuoteSource('C++', source('m3'))
    rememberNativeChatQuoteSource('C', source('m4'))
    expect(nativeChatQuoteSource('x & y')?.messageId).toBe('m1')
    expect(nativeChatQuoteSource('C++')?.messageId).toBe('m3')
    rememberNativeChatQuoteSource('a <br> b', source('m5'))
    rememberNativeChatQuoteSource('a  b', source('m6'))
    expect(nativeChatQuoteSource('a <br> b')?.messageId).toBe('m5')
  })

  it('keeps the newest 200 sources and survives bad storage', () => {
    for (let index = 0; index < 201; index++) {
      rememberNativeChatQuoteSource(`quote ${index}`, source(`m${index}`))
    }
    expect(nativeChatQuoteSource('quote 0')).toBeNull()
    expect(nativeChatQuoteSource('quote 200')?.messageId).toBe('m200')
    localStorage.setItem('orca.nativeChat.quoteSources', '{bad')
    expect(nativeChatQuoteSource('quote 200')).toBeNull()
  })

  it('reads the file of a quote only from a header line that a code fence follows', () => {
    expect(quotedFileLocation('src/a b.ts:12-20', true)).toEqual({
      pathText: 'src/a b.ts',
      line: 12
    })
    expect(quotedFileLocation('README.md:3', true)).toEqual({ pathText: 'README.md', line: 3 })
    expect(quotedFileLocation('README.md', true)).toEqual({ pathText: 'README.md', line: 1 })
    expect(quotedFileLocation('Meeting Notes.md', true)).toEqual({
      pathText: 'Meeting Notes.md',
      line: 1
    })
    expect(quotedFileLocation('Terminal', true)).toBeNull()
    expect(quotedFileLocation('user@host: ~/project', true)).toBeNull()
    for (const chat of ['v1.2', 'e.g', 'and/or', 'example.com', 'README.md:3']) {
      expect(quotedFileLocation(chat, false)).toBeNull()
    }
  })
})

describe('jumpToQuoteSource', () => {
  const deps = () => ({
    jumpToMessage: vi.fn(() => true),
    openFile: vi.fn(() => true),
    notifyMissing: vi.fn()
  })
  const fileQuote = 'src/a.ts:7-9\n```ts\nconst a = 1\n```'

  it('goes to the remembered message first', () => {
    rememberNativeChatQuoteSource(fileQuote, source('reply-1'))
    const fake = deps()
    expect(jumpToQuoteSource(fileQuote, fake)).toBe('message')
    expect(fake.jumpToMessage).toHaveBeenCalledWith(
      source('reply-1'),
      fileQuote,
      fake.notifyMissing,
      expect.any(Function)
    )
    expect(fake.openFile).not.toHaveBeenCalled()
  })

  it('opens the quoted file when no message is known or the message is gone', () => {
    rememberNativeChatQuoteSource(fileQuote, source('gone'))
    const fake = { ...deps(), jumpToMessage: vi.fn(() => false) }
    expect(jumpToQuoteSource(fileQuote, fake)).toBe('file')
    expect(fake.openFile).toHaveBeenCalledWith({ pathText: 'src/a.ts', line: 7 })
  })

  it('shows a notice for a chat quote that only looks like a path', () => {
    for (const text of ['v1.2', 'example.com', 'and/or\nmore text']) {
      const fake = deps()
      expect(jumpToQuoteSource(text, fake)).toBe('missing')
      expect(fake.openFile).not.toHaveBeenCalled()
      expect(fake.notifyMissing).toHaveBeenCalledOnce()
    }
  })
})
