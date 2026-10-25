import { beforeEach, describe, expect, it, vi } from 'vitest'
import emojiShortcodes from 'emojibase-data/en/shortcodes/emojibase.json'

async function importConfiguredCatalog() {
  const catalog = await import('./emoji-shortcode-catalog.js')
  const loadDataset = vi.fn(() => emojiShortcodes)
  catalog.setEmojiShortcodeDatasetLoader(loadDataset)
  return { catalog, loadDataset }
}

describe('emoji shortcode catalog laziness', () => {
  beforeEach(() => {
    vi.resetModules()
  })

  it('does not build the catalog when the shared module is imported', async () => {
    const { catalog, loadDataset } = await importConfiguredCatalog()

    expect(loadDataset).not.toHaveBeenCalled()

    const entries = catalog.getStandardEmojiShortcodeEntries()
    expect(entries).toContainEqual({ emoji: '🎉', shortcode: 'party' })
    expect(catalog.getStandardEmojiShortcodeEntries()).toBe(entries)
    expect(loadDataset).toHaveBeenCalledTimes(1)
  })

  it('loads once when replacing emoji and reuses the catalog', async () => {
    const { catalog, loadDataset } = await importConfiguredCatalog()

    expect(catalog.replaceKnownEmojiWithShortcodes('ship \u{1F389}')).toBe('ship  party ')
    expect(catalog.replaceKnownEmojiWithShortcodes('again 🎉')).toBe('again  party ')
    expect(loadDataset).toHaveBeenCalledTimes(1)
  })
})
