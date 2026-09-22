import { readFileSync } from 'node:fs'
import { join } from 'node:path'
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

  it('leaves the main-process worktree namer importing only the deferred entry points', () => {
    // A cross-project import would drag src/main into the shared tsconfig, so assert on source.
    const worktreeLogic = readFileSync(join(__dirname, '../main/ipc/worktree-logic.ts'), 'utf8')
    const catalogImport = worktreeLogic.match(
      /import \{([^}]*)\} from '[^']*emoji-shortcode-catalog'/
    )

    expect(catalogImport?.[1].split(',').map((name) => name.trim())).toEqual([
      'replaceKnownEmojiWithShortcodes',
      'setEmojiShortcodeDatasetLoader'
    ])
  })

  it('keeps the catalog build out of module scope', () => {
    const sharedSource = readFileSync(join(__dirname, 'emoji-shortcode-catalog.ts'), 'utf8')

    // A module-scope `const X = <expression over the dataset>` is the regression this guards.
    expect(sharedSource).not.toMatch(/^const \w+ = Object\.entries\(/m)
    expect(sharedSource).not.toMatch(/^const \w+ = new (?:Map|Intl\.Segmenter)\(/m)
    expect(sharedSource).toContain('function loadCatalog()')
  })

  it('keeps the 166 KB dataset off every module main statically imports', () => {
    const sharedSource = readFileSync(join(__dirname, 'emoji-shortcode-catalog.ts'), 'utf8')
    const worktreeLogic = readFileSync(join(__dirname, '../main/ipc/worktree-logic.ts'), 'utf8')

    // A static `emojibase-data` import anywhere main reaches inlines the dataset into
    // out/main/index.js and JSON.parses it on every launch.
    const staticDatasetImport = /\bfrom '[^']*emojibase-data[^']*'/
    expect(sharedSource).not.toMatch(staticDatasetImport)
    expect(worktreeLogic).not.toMatch(staticDatasetImport)
  })
})
