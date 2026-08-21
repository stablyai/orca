import emojiShortcodes from 'emojibase-data/en/shortcodes/emojibase.json'

export type StandardEmojiShortcodeEntry = {
  emoji: string
  shortcode: string
}

// Skin-tone aliases (`wave_tone3`) are ~40% of the dataset and would drown the suggestion list.
const SKIN_TONE_SHORTCODE = /_tone\d(?:-\d)?$/

const CATALOG = Object.entries(emojiShortcodes).flatMap(([hexcode, value]) => {
  const shortcodes = (typeof value === 'string' ? [value] : value).filter(
    (shortcode) => !SKIN_TONE_SHORTCODE.test(shortcode)
  )
  return shortcodes.length > 0 ? [{ emoji: hexcodeToEmoji(hexcode), shortcodes }] : []
})

export const STANDARD_EMOJI_SHORTCODE_ENTRIES: readonly StandardEmojiShortcodeEntry[] =
  CATALOG.flatMap(({ emoji, shortcodes }) => shortcodes.map((shortcode) => ({ emoji, shortcode })))

const PRIMARY_SHORTCODE_BY_EMOJI = new Map(
  CATALOG.map(({ emoji, shortcodes }) => [
    normalizeEmojiLookup(emoji),
    primaryShortcode(shortcodes)
  ])
)

/**
 * Pick the alias that reads best as a branch or directory name: skip `+1`/`-1` so the name
 * starts with a letter, then cryptic stubs (👎 `no`, ✌ `v`) and the `flag_xx` namespacing
 * prefix, both of which have a spelled-out alias (`thumbsdown`, `victory`, `germany`).
 */
function primaryShortcode(shortcodes: readonly string[]): string {
  const named = shortcodes.filter((candidate) => /^[a-z]/i.test(candidate))
  return (
    named.find((candidate) => candidate.length >= 3 && !candidate.startsWith('flag_')) ??
    named.find((candidate) => candidate.length >= 3) ??
    named[0] ??
    shortcodes[0]
  )
}

const EMOJI_SEGMENTER = new Intl.Segmenter('en', { granularity: 'grapheme' })

export function replaceKnownEmojiWithShortcodes(input: string): string {
  return Array.from(EMOJI_SEGMENTER.segment(input), ({ segment }) => {
    const shortcode = PRIMARY_SHORTCODE_BY_EMOJI.get(normalizeEmojiLookup(segment))
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
