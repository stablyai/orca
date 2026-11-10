const ALTERNATE_SCREEN_ENTRY = '\x1b[?1049h'

/** Splits a serialized image at its last alt-screen entry; null when it never enters alt. */
export function splitAtAlternateScreenEntry(
  ansi: string
): { normalAnsi: string; alternateAnsi: string } | null {
  const start = ansi.lastIndexOf(ALTERNATE_SCREEN_ENTRY)
  if (start === -1) {
    return null
  }
  return {
    normalAnsi: ansi.slice(0, start),
    alternateAnsi: ansi.slice(start + ALTERNATE_SCREEN_ENTRY.length)
  }
}
