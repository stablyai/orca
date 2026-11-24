import { translatedSlotParts, type TranslatedSlotPart } from '../../i18n/translated-slot-order'

export type ForkMarkedNamePart = TranslatedSlotPart<'mark' | 'name'>

/** Fills a translated "{{mark}} {{name}}" order with these to split it. */
export const FORK_MARKED_NAME_SLOTS = { mark: '\u0001', name: '\u0002' }

const MARK: ForkMarkedNamePart = { key: 'mark', kind: 'mark' }
const NAME: ForkMarkedNamePart = { key: 'name', kind: 'name' }
const SLOTS = [
  { marker: FORK_MARKED_NAME_SLOTS.mark, part: MARK },
  { marker: FORK_MARKED_NAME_SLOTS.name, part: NAME }
]
const ENGLISH_ORDER: ForkMarkedNamePart[] = [MARK, { key: 'text-1', kind: 'text', text: ' ' }, NAME]

/** Splits the filled order into nodes, so the name is never parsed as markup. A translation that
 *  lost or doubled a placeholder falls back to the English order. */
export function forkMarkedNameParts(filled: string): ForkMarkedNamePart[] {
  return translatedSlotParts(filled, SLOTS, ENGLISH_ORDER)
}
