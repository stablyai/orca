import { afterEach, expect, it } from 'vitest'
import { i18n } from '@/i18n/i18n'
import es from '@/i18n/locales/es.json'
import { getChatBehaviorEntriesByKey } from '../chat/chat-behavior-search'
import { matchesSettingsSearch } from './settings-search'

afterEach(async () => {
  await i18n.changeLanguage('en')
})

it('matches English and Spanish keywords in a localized settings search', async () => {
  i18n.addResourceBundle('es', 'translation', es)
  await i18n.changeLanguage('es')
  const entry = getChatBehaviorEntriesByKey().markNewMessages
  expect(matchesSettingsSearch('unread', entry)).toBe(true)
  expect(matchesSettingsSearch('no leído', entry)).toBe(true)
})
