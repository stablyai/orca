/** A piece of a translated template: one of its slots, or the text the translation put between them. */
// Distributes over the slots so each `kind` check narrows on its own.
export type TranslatedSlotPart<Slot extends string> = { key: string } & (
  | (Slot extends string ? { kind: Slot } : never)
  | { kind: 'text'; text: string }
)

/**
 * Splits a translation filled with one marker character per slot into its pieces in the locale's
 * order, so a value is never parsed as markup. A translation that lost or doubled a slot falls
 * back to `english`.
 */
export function translatedSlotParts<Slot extends string>(
  filled: string,
  markers: Readonly<Record<Slot, string>>,
  english: TranslatedSlotPart<Slot>[]
): TranslatedSlotPart<Slot>[] {
  // The English order holds each slot's part once; its markers find them in the translation.
  const slotPartByMarker = new Map<string, TranslatedSlotPart<Slot>>()
  for (const part of english) {
    if (part.kind !== 'text') {
      slotPartByMarker.set(markers[part.kind as Slot], part)
    }
  }
  if (
    Object.values<string>(markers).some((marker) => filled.split(marker).length !== 2) ||
    slotPartByMarker.size !== Object.keys(markers).length
  ) {
    return english
  }
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
    const slotPart = slotPartByMarker.get(char)
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
