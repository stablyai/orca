// Avatar initials from a display name, falling back to the login; emoji never produce broken surrogates.
export function initialsFor(login: string, name?: string | null): string {
  const source = (name?.trim() || login).trim()
  if (!source) {
    return '?'
  }
  const alnum = (word: string): string[] => [...word].filter((ch) => /[\p{L}\p{N}]/u.test(ch))
  const parts = source.split(/\s+/).filter(Boolean)
  const letters =
    parts.length >= 2
      ? parts
          .map((word) => alnum(word)[0])
          .filter(Boolean)
          .slice(0, 2)
          .join('')
      : alnum(source).slice(0, 2).join('')
  return letters.toUpperCase() || '?'
}
