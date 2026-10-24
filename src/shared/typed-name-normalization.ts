export function stripWrappingQuotes(value: string): string {
  const quote = value[0]
  return value.length >= 2 && (quote === "'" || quote === '"') && value.at(-1) === quote
    ? value.slice(1, -1)
    : value
}

/** How a typed host, server or project name is compared: trimmed, unquoted, case-insensitive. */
export function normalizeTypedName(value: string): string {
  return stripWrappingQuotes(value.trim()).trim().toLowerCase()
}
