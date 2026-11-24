import { translatedSlotParts, type TranslatedSlotPart } from '../../i18n/translated-slot-order'

export type ForkMarkedNamePart = TranslatedSlotPart<'mark' | 'name'>

/** Fills a translated "{{mark}} {{name}}" order with these to split it. */
export const FORK_MARKED_NAME_SLOTS = { mark: '\u0001', name: '\u0002' }

const ENGLISH_ORDER: ForkMarkedNamePart[] = [
  { key: 'mark', kind: 'mark' },
  { key: 'text-1', kind: 'text', text: ' ' },
  { key: 'name', kind: 'name' }
]

/** Splits the filled order into nodes, so the name is never parsed as markup. A translation that
 *  lost or doubled a placeholder falls back to the English order. */
export function forkMarkedNameParts(filled: string): ForkMarkedNamePart[] {
  return translatedSlotParts(filled, FORK_MARKED_NAME_SLOTS, ENGLISH_ORDER)
}
