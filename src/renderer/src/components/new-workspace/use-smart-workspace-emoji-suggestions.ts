import { useMemo } from 'react'
import {
  getActiveWorkspaceEmojiShortcode,
  searchWorkspaceEmojiShortcodes,
  type WorkspaceEmojiSuggestion
} from '@/lib/workspace-emoji-shortcodes'

export function useSmartWorkspaceEmojiSuggestions({
  value,
  emojiCursor,
  emojiCommandValue,
  disabled,
  hasSelectedSource
}: {
  value: string
  emojiCursor: number | null
  emojiCommandValue: string
  disabled: boolean
  hasSelectedSource: boolean
}): {
  activeEmojiShortcode: ReturnType<typeof getActiveWorkspaceEmojiShortcode>
  emojiSuggestions: WorkspaceEmojiSuggestion[]
  emojiMenuOpen: boolean
  resolvedEmojiCommandValue: string
  selectedEmojiSuggestion: WorkspaceEmojiSuggestion | null
} {
  const activeEmojiShortcode = useMemo(
    () => getActiveWorkspaceEmojiShortcode(value, emojiCursor),
    [emojiCursor, value]
  )
  const emojiSuggestions = useMemo(
    () =>
      activeEmojiShortcode
        ? searchWorkspaceEmojiShortcodes(activeEmojiShortcode.query)
        : ([] as WorkspaceEmojiSuggestion[]),
    [activeEmojiShortcode]
  )
  const emojiMenuOpen =
    !disabled && !hasSelectedSource && activeEmojiShortcode !== null && emojiSuggestions.length > 0
  const resolvedEmojiCommandValue = emojiSuggestions.some(
    (suggestion) => `emoji:${suggestion.shortcode}` === emojiCommandValue
  )
    ? emojiCommandValue
    : emojiSuggestions[0]
      ? `emoji:${emojiSuggestions[0].shortcode}`
      : ''
  const selectedEmojiSuggestion =
    emojiSuggestions.find(
      (suggestion) => `emoji:${suggestion.shortcode}` === resolvedEmojiCommandValue
    ) ?? null
  return {
    activeEmojiShortcode,
    emojiSuggestions,
    emojiMenuOpen,
    resolvedEmojiCommandValue,
    selectedEmojiSuggestion
  }
}
