const FRONTMATTER_RE = /^(---|\+\+\+)\r?\n(?:[\s\S]*?\r?\n)?\1(?:\r?\n|$)/

export type FrontMatter = {
  /** Raw front matter including delimiters and any trailing newline. */
  raw: string
  body: string
}

export function extractFrontMatter(content: string): FrontMatter | null {
  const match = content.match(FRONTMATTER_RE)
  if (!match) {
    return null
  }

  const raw = match[0]
  const body = content.slice(raw.length)

  return { raw, body }
}

export function prependFrontMatter(raw: string, body: string): string {
  // Preserve raw block spacing; add a terminating newline only when absent so repeated saves do not accumulate newlines.
  const normalizedRaw = raw.endsWith('\n') ? raw : `${raw}\n`
  return `${normalizedRaw}${body}`
}

export function markdownFrontMatterInner(frontMatter: FrontMatter | null): string {
  return (
    frontMatter?.raw
      .replace(/^(?:---|\+\+\+)\r?\n/, '')
      .replace(/\r?\n(?:---|\+\+\+)\r?\n?$/, '')
      .trim() ?? ''
  )
}
