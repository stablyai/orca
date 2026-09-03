import type * as EmojiShortcodeCatalog from '../../../shared/emoji-shortcode-catalog'
import type { StandardEmojiShortcodeEntry } from '../../../shared/emoji-shortcode-catalog'

// Why: the shared catalog statically imports 170 KB of emojibase JSON, and the
// main process needs that import to stay synchronous (worktree slugs are
// sanitized inline). Only the renderer can defer it, so the deferral lives
// here: nothing can consume the data before the user types `:` or submits a
// workspace name, and the load is primed right after the first render.
let catalogModule: typeof EmojiShortcodeCatalog | null = null
let catalogLoad: Promise<void> | null = null

export function primeEmojiShortcodeCatalog(): Promise<void> {
  catalogLoad ??= import('../../../shared/emoji-shortcode-catalog').then(
    (module) => {
      catalogModule = module
    },
    (error) => {
      console.warn('[workspace-emoji] shortcode catalog failed to load:', error)
    }
  )
  return catalogLoad
}

export function getPrimedEmojiShortcodeEntries(): readonly StandardEmojiShortcodeEntry[] {
  if (!catalogModule) {
    void primeEmojiShortcodeCatalog()
    return []
  }
  return catalogModule.getStandardEmojiShortcodeEntries()
}

/** Test-only probe for the boot-path guard; never branch on this in product code. */
export function isEmojiShortcodeCatalogPrimedForTest(): boolean {
  return catalogModule !== null
}
