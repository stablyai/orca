/** A piece of a translated template: one of its slots, or the text the translation put between them. */
// Distributes over the slots so each `kind` check narrows on its own.
export type TranslatedSlotPart<Slot extends string> = { key: string } & (
  | (Slot extends string ? { kind: Slot } : never)
  | { kind: 'text'; text: string }
)

/** A slot's marker character, filled in for its placeholder, and the piece it becomes. */
export type TranslatedSlot<Slot extends string> = {
  marker: string
  part: TranslatedSlotPart<Slot>
}

/**
 * Splits a translation filled with one marker character per slot into its pieces in the locale's
 * order, so a value is never parsed as markup. A translation that lost or doubled a slot falls
 * back to `english`.
 */
export function translatedSlotParts<Slot extends string>(
  filled: string,
  slots: readonly TranslatedSlot<Slot>[],
  english: TranslatedSlotPart<Slot>[]
): TranslatedSlotPart<Slot>[] {
  if (slots.some(({ marker }) => filled.split(marker).length !== 2)) {
    return english
  }
  const partByMarker = new Map(slots.map(({ marker, part }) => [marker, part]))
  const parts: TranslatedSlotPart<Slot>[] = []
  let text = ''
  // Text runs are keyed by how many slots precede them: at most one run per gap.
  const flush = (): void => {
    if (text) {
      parts.push({ key: `text-${parts.length}`, kind: 'text', text })
      text = ''
    }
  }
  for (const char of filled) {
    const slotPart = partByMarker.get(char)
    if (!slotPart) {
      text += char
      continue
    }
    flush()
    parts.push(slotPart)
  }
  flush()
  return parts
}
