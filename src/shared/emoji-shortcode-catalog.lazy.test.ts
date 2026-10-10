import { beforeEach, describe, expect, it, vi } from 'vitest'
import emojiShortcodes from 'emojibase-data/en/shortcodes/emojibase.json'

async function importConfiguredCatalog() {
  const catalog = await import('./emoji-shortcode-catalog.js')
  catalog.setEmojiShortcodeDatasetLoader(() => emojiShortcodes)
  return catalog
}

describe('emoji shortcode catalog laziness', () => {
  beforeEach(() => {
    vi.resetModules()
  })

  it('does not build the catalog when the shared module is imported', async () => {
    const catalog = await importConfiguredCatalog()

    expect(catalog.isEmojiShortcodeCatalogBuiltForTest()).toBe(false)

    expect(catalog.getStandardEmojiShortcodeEntries().length).toBeGreaterThan(1000)
    expect(catalog.isEmojiShortcodeCatalogBuiltForTest()).toBe(true)
  })

  it('builds on first use and keeps the main process off the eager path', async () => {
    const catalog = await importConfiguredCatalog()

    expect(catalog.replaceKnownEmojiWithShortcodes('ship \u{1F389}')).toBe('ship  party ')
    expect(catalog.isEmojiShortcodeCatalogBuiltForTest()).toBe(true)
  })
})
