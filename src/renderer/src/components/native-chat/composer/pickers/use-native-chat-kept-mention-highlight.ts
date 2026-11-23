import { useLayoutEffect, useRef, type Dispatch, type SetStateAction } from 'react'
import type { ComposerAutocomplete } from '../../../../../../shared/native-chat/input/composer/native-chat-composer-autocomplete'

export type ShownMentionRows = { rows: readonly string[]; query: string | null; value?: string }

/** The highlight after the `@` rows change: rows that arrive with no edit (a list read late) keep
 *  the highlighted row, so Enter never picks a row that moved under it. */
export function keptMentionHighlight(
  shown: ShownMentionRows | null,
  rows: readonly string[],
  query: string | null,
  active: number
): number {
  if (query === null || !shown || shown.rows === rows || shown.query !== query || !shown.value) {
    return active
  }
  const kept = rows.indexOf(shown.value)
  return kept === -1 ? active : kept
}

export function useNativeChatKeptMentionHighlight(
  mentions: { mentionFiles: { files: readonly string[] }; autocomplete: ComposerAutocomplete },
  active: number,
  setActive: Dispatch<SetStateAction<number>>
): void {
  const rows = mentions.mentionFiles.files
  const { autocomplete } = mentions
  const query = autocomplete.mode === 'mention' ? (autocomplete.query ?? '') : null
  const shown = useRef<ShownMentionRows | null>(null)
  // Why layout: the moved highlight replaces the old one before the menu paints.
  useLayoutEffect(() => {
    const index = keptMentionHighlight(shown.current, rows, query, active)
    shown.current = { rows, query, value: rows[Math.min(index, rows.length - 1)] }
    if (index !== active) {
      setActive(index)
    }
  }, [rows, query, active, setActive])
}
