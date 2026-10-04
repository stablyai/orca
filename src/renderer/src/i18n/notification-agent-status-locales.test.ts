import { describe, expect, it } from 'vitest'
import en from './locales/en.json'
import es from './locales/es.json'
import fr from './locales/fr.json'
import ja from './locales/ja.json'
import ko from './locales/ko.json'
import zh from './locales/zh.json'

// Main words a notification from these keys with an English fallback, so a locale missing one
// silently notifies in English; no other gate catches it.
describe('notification agent status locales', () => {
  it.each(Object.entries({ en, es, fr, ja, ko, zh }))(
    '%s words every verdict',
    (_locale, catalog) => {
      const words = catalog.notifications.agentStatus
      for (const key of ['needsInput', 'working', 'stopped', 'failed', 'finished'] as const) {
        expect(words[key]).toEqual(expect.any(String))
        expect(words[key].length).toBeGreaterThan(0)
      }
    }
  )
})
