// @vitest-environment happy-dom
import { afterEach, expect, it, vi } from 'vitest'

/** The quote sources as one app window sees them: each window loads the module on its own. */
async function appWindow() {
  vi.resetModules()
  return import('./native-chat-quote-sources')
}

const at = (messageId: string) => ({ messageId, place: null })

afterEach(() => localStorage.clear())

it('stores a short entry for a very long quote, and still finds it', async () => {
  const sources = await appWindow()
  const quote = 'long quote line\n'.repeat(5000)
  sources.rememberNativeChatQuoteSource(quote, at('reply-1'))
  const stored = Object.keys(localStorage).map((key) => localStorage.getItem(key) ?? '')
  expect(stored.join('').length).toBeLessThan(200)
  expect(stored.join('')).not.toContain('long quote line')
  expect(sources.nativeChatQuoteSource(quote)?.messageId).toBe('reply-1')
})

it('shares the sources between app windows without one window losing the other one', async () => {
  const first = await appWindow()
  const second = await appWindow()
  first.rememberNativeChatQuoteSource('alpha', at('m1'))
  second.rememberNativeChatQuoteSource('beta', at('m2'))
  first.rememberNativeChatQuoteSource('gamma', at('m3'))
  expect(first.nativeChatQuoteSource('beta')?.messageId).toBe('m2')
  expect(second.nativeChatQuoteSource('gamma')?.messageId).toBe('m3')
  expect((await appWindow()).nativeChatQuoteSource('beta')?.messageId).toBe('m2')
})

it('keeps the chat of a source, and reads sources stored before it as of no chat', async () => {
  const sources = await appWindow()
  sources.rememberNativeChatQuoteSource('alpha', { ...at('m1'), chat: 'claude:s1' })
  expect(sources.nativeChatQuoteSource('alpha')).toEqual({ ...at('m1'), chat: 'claude:s1' })
  // An entry of the earlier shape: no chat.
  const key = Object.keys(localStorage)[0]
  const [stored] = JSON.parse(localStorage.getItem(key) ?? '[]')
  localStorage.setItem(key, JSON.stringify([stored.slice(0, 5)]))
  expect(sources.nativeChatQuoteSource('alpha')).toEqual(at('m1'))
})
