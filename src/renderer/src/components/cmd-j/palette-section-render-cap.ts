/**
 * Typed queries used to render every match as a DOM row — a one-character query
 * against a few hundred workspaces built hundreds of `CommandItem`s (each with
 * status dots, badges and highlight spans) on every keystroke. Capping the
 * rendered slice bounds worst-case DOM without changing ranking: the top matches
 * are already the ones the user wants, and the overflow hint points at the two
 * ways to reach the rest.
 */
export const PALETTE_SECTION_RENDER_CAP = 50

export type CappedPaletteSection<T> = {
  visible: readonly T[]
  overflowCount: number
}

export function capPaletteSection<T>(
  items: readonly T[],
  cap: number = PALETTE_SECTION_RENDER_CAP
): CappedPaletteSection<T> {
  if (!Number.isFinite(cap) || cap < 0 || items.length <= cap) {
    return { visible: items, overflowCount: 0 }
  }
  return { visible: items.slice(0, cap), overflowCount: items.length - cap }
}
