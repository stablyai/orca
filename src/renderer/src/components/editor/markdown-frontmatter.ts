const FRONTMATTER_RE = /^(---|\+\+\+)\r?\n([\s\S]*?)\r?\n\1(?:\r?\n|$)/

export type FrontMatter = {
  /** The full raw front-matter block including delimiters and trailing newline. */
  raw: string
  /** The document body after the front-matter block. */
  body: string
}

/**
 * Extracts a YAML (`---`) or TOML (`+++`) front-matter block from the start
 * of a markdown document. Returns null if no front-matter is present.
 */
export function extractFrontMatter(content: string): FrontMatter | null {
  const match = content.match(FRONTMATTER_RE)
  if (!match) {
    return null
  }

  const raw = match[0]
  const body = content.slice(raw.length)

  return { raw, body }
}

/**
 * Re-assembles a full markdown document from a raw front-matter block and body.
 * Ensures exactly one newline separates the front-matter block from the body.
 */
export function prependFrontMatter(raw: string, body: string): string {
  // Why: the raw block captured by extractFrontMatter may or may not end with
  // a newline depending on whether the original document had a blank line after
  // the closing delimiter. Normalising to exactly one trailing newline prevents
  // accumulating extra blank lines on every save cycle.
  const normalizedRaw = raw.endsWith('\n') ? raw : `${raw}\n`
  return `${normalizedRaw}${body}`
}
