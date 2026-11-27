const WINDOWS_RESERVED_NAME = /^(con|prn|aux|nul|com\d|lpt\d)$/

/** A folder name every supported filesystem accepts. */
export function botFolderName(botName: string): string {
  const slug = botName
    .normalize('NFKD')
    .toLowerCase()
    // Why: NFKD leaves an accent as a combining mark; drop it so it doesn't split the word.
    .replace(/(\p{M}+)|[^a-z0-9]+/gu, (_run, marks) => (marks ? '' : '-'))
    .replace(/^-+|-+$/g, '')
    .slice(0, 40)
    .replace(/-+$/, '')
  if (!slug) {
    return 'bot'
  }
  return WINDOWS_RESERVED_NAME.test(slug) ? `${slug}-bot` : slug
}
