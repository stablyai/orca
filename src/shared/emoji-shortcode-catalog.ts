export type StandardEmojiShortcodeEntry = {
  emoji: string
  shortcode: string
}

/** Shape of `emojibase-data/en/shortcodes/emojibase.json`: hexcode -> shortcode or aliases. */
export type EmojiShortcodeDataset = Readonly<Record<string, string | readonly string[]>>

let loadDataset: (() => EmojiShortcodeDataset) | null = null

/** Renderer needs eager synchronous data or it persists literal :wink: during load. Inject main’s lazy require to avoid bundling/parsing 166KB at launch. */
export function setEmojiShortcodeDatasetLoader(load: () => EmojiShortcodeDataset): void {
  loadDataset = load
}

// Skin-tone aliases (`wave_tone3`) are ~40% of the dataset and would drown the suggestion list.
const SKIN_TONE_SHORTCODE = /_tone\d(?:-\d)?$/

type EmojiShortcodeCatalog = {
  entries: readonly StandardEmojiShortcodeEntry[]
  primaryShortcodeByEmoji: ReadonlyMap<string, string>
  segmenter: Intl.Segmenter
}

let catalog: EmojiShortcodeCatalog | null = null

// Defer ~3,900-shortcode traversal until first colon/name sanitization, memoizing once instead of charging every launch.
function loadCatalog(): EmojiShortcodeCatalog {
  if (catalog) {
    return catalog
  }
  if (!loadDataset) {
    throw new Error('Emoji shortcode dataset loader was never registered')
  }
  const grouped = Object.entries(loadDataset()).flatMap(([hexcode, value]) => {
    const shortcodes = (typeof value === 'string' ? [value] : value).filter(
      (shortcode) => !SKIN_TONE_SHORTCODE.test(shortcode)
    )
    return shortcodes.length > 0 ? [{ emoji: hexcodeToEmoji(hexcode), shortcodes }] : []
  })
  catalog = {
    entries: grouped.flatMap(({ emoji, shortcodes }) =>
      shortcodes.map((shortcode) => ({ emoji, shortcode }))
    ),
    primaryShortcodeByEmoji: new Map(
      grouped.map(({ emoji, shortcodes }) => [
        normalizeEmojiLookup(emoji),
        primaryShortcode(shortcodes)
      ])
    ),
    segmenter: new Intl.Segmenter('en', { granularity: 'grapheme' })
  }
  return catalog
}

export function getStandardEmojiShortcodeEntries(): readonly StandardEmojiShortcodeEntry[] {
  return loadCatalog().entries
}

/** Test-only probe for the lazy-boundary guard; never branch on this in product code. */
export function isEmojiShortcodeCatalogBuiltForTest(): boolean {
  return catalog !== null
}

/** Prefer spelled-out names over symbolic +1/-1, cryptic no/v and flag_xx namespaces for branch/directory labels. */
function primaryShortcode(shortcodes: readonly string[]): string {
  const named = shortcodes.filter((candidate) => /^[a-z]/i.test(candidate))
  return (
    named.find((candidate) => candidate.length >= 3 && !candidate.startsWith('flag_')) ??
    named.find((candidate) => candidate.length >= 3) ??
    named[0] ??
    shortcodes[0]
  )
}

export function replaceKnownEmojiWithShortcodes(input: string): string {
  const { primaryShortcodeByEmoji, segmenter } = loadCatalog()
  return Array.from(segmenter.segment(input), ({ segment }) => {
    const shortcode = primaryShortcodeByEmoji.get(normalizeEmojiLookup(segment))
    return shortcode ? ` ${shortcode.replaceAll('_', '-')} ` : segment
  }).join('')
}

function normalizeEmojiLookup(emoji: string): string {
  return Array.from(emoji)
    .filter((character) => {
      const codepoint = character.codePointAt(0)
      return (
        character !== '\ufe0f' &&
        (codepoint === undefined || codepoint < 0x1f3fb || codepoint > 0x1f3ff)
      )
    })
    .join('')
}

function hexcodeToEmoji(hexcode: string): string {
  return hexcode
    .split('-')
    .map((codepoint) => String.fromCodePoint(Number.parseInt(codepoint, 16)))
    .join('')
}
