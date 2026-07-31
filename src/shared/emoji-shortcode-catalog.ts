import emojiShortcodes from 'emojibase-data/en/shortcodes/github.json'

export type StandardEmojiShortcodeEntry = {
  emoji: string
  shortcode: string
}

export const STANDARD_EMOJI_SHORTCODE_ENTRIES: readonly StandardEmojiShortcodeEntry[] =
  Object.entries(emojiShortcodes).flatMap(([hexcode, value]) => {
    const shortcodes = typeof value === 'string' ? [value] : value
    const emoji = hexcodeToEmoji(hexcode)
    return shortcodes.map((shortcode) => ({ emoji, shortcode }))
  })

const PRIMARY_SHORTCODE_BY_EMOJI = new Map(
  Object.entries(emojiShortcodes).map(([hexcode, value]) => {
    const shortcodes = typeof value === 'string' ? [value] : value
    const shortcode = shortcodes.find((candidate) => /^[a-z]/i.test(candidate)) ?? shortcodes[0]
    return [normalizeEmojiLookup(hexcodeToEmoji(hexcode)), shortcode]
  })
)

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
