// Shared cell display for the result grids. NULL is rendered distinct from an
// empty string; objects (json/arrays) are stringified for display. Pure — no
// side effects — so it is safe to import from table-data-edit-buffer for
// sameCellValue comparisons without introducing toast/i18n dependencies there.

export function formatCell(value: unknown): { text: string; isNull: boolean } {
  if (value === null || value === undefined) {
    return { text: 'NULL', isNull: true }
  }
  // Dates (timestamp columns) render as ISO, not a JSON-quoted string.
  if (value instanceof Date) {
    return { text: value.toISOString(), isNull: false }
  }
  // Binary columns (bytea/BLOB → Buffer/Uint8Array) show a size, not a byte dump.
  if (value instanceof Uint8Array) {
    return { text: `[${value.length} bytes]`, isNull: false }
  }
  if (typeof value === 'object') {
    return { text: JSON.stringify(value), isNull: false }
  }
  return { text: String(value), isNull: false }
}
