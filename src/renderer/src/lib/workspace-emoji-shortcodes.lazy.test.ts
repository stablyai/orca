import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { beforeEach, describe, expect, it, vi } from 'vitest'

describe('workspace emoji shortcode index laziness', () => {
  beforeEach(() => {
    vi.resetModules()
  })

  it('does not build the shared catalog when the renderer index is imported', async () => {
    const shortcodeIndex = await import('./workspace-emoji-shortcodes')
    const catalog = await import('../../../shared/emoji-shortcode-catalog')

    expect(catalog.isEmojiShortcodeCatalogBuiltForTest()).toBe(false)

    // Cursor/regex-only paths must stay off the catalog too.
    expect(shortcodeIndex.getActiveWorkspaceEmojiShortcode('hi :tad', 7)).not.toBeNull()
    expect(catalog.isEmojiShortcodeCatalogBuiltForTest()).toBe(false)

    expect(shortcodeIndex.searchWorkspaceEmojiShortcodes('tada')[0]?.emoji).toBe('🎉')
    expect(catalog.isEmojiShortcodeCatalogBuiltForTest()).toBe(true)
  })

  it('keeps the exact-shortcode index out of module scope', () => {
    const indexSource = readFileSync(join(__dirname, 'workspace-emoji-shortcodes.ts'), 'utf8')

    expect(indexSource).not.toMatch(/^const \w+ = new Map\(/m)
    expect(indexSource).not.toContain('STANDARD_EMOJI_SHORTCODE_ENTRIES')
  })
})
