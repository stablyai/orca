/**
 * Turns a font name from a workbook into a CSS font-family value.
 *
 * Why sanitise: the name is attacker-controlled text from an opened file, and it
 * ends up in an inline style. Anything but a plain typeface name is dropped rather
 * than escaped, so no quote, semicolon or parenthesis can reach the CSS.
 */
const SAFE_FONT_NAME = /^[A-Za-z0-9][A-Za-z0-9 \-_]{0,63}$/

// Why: the file names one typeface, which the reader's machine may not have. The
// stack behind it keeps a sheet legible instead of falling back to a serif.
const FALLBACK_STACK = 'ui-sans-serif, system-ui, sans-serif'

export function resolveXlsxFontFamily(name: string | undefined): string | undefined {
  if (name === undefined) {
    return undefined
  }
  const trimmed = name.trim()
  if (!SAFE_FONT_NAME.test(trimmed)) {
    return undefined
  }
  return `"${trimmed}", ${FALLBACK_STACK}`
}
