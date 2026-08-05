/**
 * The `menu.*` namespace backs the OS menu bar, which every supported locale
 * currently covers in full. A missing key there is invisible: translateMain()
 * silently serves the English fallback next to localized siblings, and the
 * catalog gate only warns because unrelated namespaces have known gaps.
 */
import { describe, expect, it } from 'vitest'
import en from './locales/en.json'
import es from './locales/es.json'
import ja from './locales/ja.json'
import ko from './locales/ko.json'
import zh from './locales/zh.json'

const catalogs = { es, ja, ko, zh }

describe('OS menu locale parity', () => {
  it.each(Object.entries(catalogs))('%s translates every menu item', (_code, catalog) => {
    const menu: Record<string, string> = catalog.menu
    for (const [key, english] of Object.entries(en.menu)) {
      expect(menu[key], `menu.${key} missing from catalog`).toBeDefined()
      expect(menu[key]?.trim()).not.toBe('')
      expect(menu[key], `menu.${key} fell back to the English source`).not.toBe(english)
    }
  })
})
