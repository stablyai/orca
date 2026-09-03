import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { beforeEach, describe, expect, it, vi } from 'vitest'

describe('workspace emoji shortcode index laziness', () => {
  beforeEach(() => {
    vi.resetModules()
  })

  it('does not build the shared catalog when the renderer index is imported', async () => {
    const shortcodeIndex = await import('./workspace-emoji-shortcodes')
    const loader = await import('./emoji-shortcode-catalog-loader')
    const catalog = await import('../../../shared/emoji-shortcode-catalog')

    expect(loader.isEmojiShortcodeCatalogPrimedForTest()).toBe(false)
    expect(catalog.isEmojiShortcodeCatalogBuiltForTest()).toBe(false)

    // Cursor/regex-only paths must stay off the catalog too.
    expect(shortcodeIndex.getActiveWorkspaceEmojiShortcode('hi :tad', 7)).not.toBeNull()
    expect(loader.isEmojiShortcodeCatalogPrimedForTest()).toBe(false)

    await loader.primeEmojiShortcodeCatalog()
    expect(shortcodeIndex.searchWorkspaceEmojiShortcodes('tada')[0]?.emoji).toBe('🎉')
    expect(catalog.isEmojiShortcodeCatalogBuiltForTest()).toBe(true)
  })

  it('keeps emojibase off the renderer module graph until it is primed', () => {
    const indexSource = readFileSync(join(__dirname, 'workspace-emoji-shortcodes.ts'), 'utf8')
    const loaderSource = readFileSync(join(__dirname, 'emoji-shortcode-catalog-loader.ts'), 'utf8')

    // A static value import of the shared catalog puts 170 KB of emojibase JSON
    // back in the boot chunk; only the `import type` and the dynamic one are ok.
    expect(indexSource).not.toMatch(/^import \{[^}]*\} from '[^']*emoji-shortcode-catalog'/m)
    expect(loaderSource).not.toMatch(/^import \{[^}]*\} from '[^']*emoji-shortcode-catalog'/m)
    expect(loaderSource).toContain("import('../../../shared/emoji-shortcode-catalog')")
  })

  it('keeps the exact-shortcode index out of module scope', () => {
    const indexSource = readFileSync(join(__dirname, 'workspace-emoji-shortcodes.ts'), 'utf8')

    expect(indexSource).not.toMatch(/^const \w+ = new Map\(/m)
    expect(indexSource).not.toContain('STANDARD_EMOJI_SHORTCODE_ENTRIES')
  })
})
