import { useMemo } from 'react'
import {
  getActiveWorkspaceEmojiShortcode,
  searchWorkspaceEmojiShortcodes,
  type WorkspaceEmojiSuggestion
} from '@/lib/workspace-emoji-shortcodes'
import type { SmartWorkspaceNameSelection } from './smart-workspace-name-field-model'

export function useSmartWorkspaceEmojiPresentation({
  value,
  emojiCursor,
  disabled,
  selectedSource,
  emojiCommandValue
}: {
  value: string
  emojiCursor: number | null
  disabled: boolean
  selectedSource: SmartWorkspaceNameSelection | null
  emojiCommandValue: string
}) {
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
    !disabled &&
    selectedSource === null &&
    activeEmojiShortcode !== null &&
    emojiSuggestions.length > 0
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
