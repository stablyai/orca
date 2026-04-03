export type MarkdownRichModeUnsupportedReason =
  | 'frontmatter'
  | 'jsx'
  | 'reference-links'
  | 'footnotes'
  | 'tables'

type UnsupportedMatch = {
  reason: MarkdownRichModeUnsupportedReason
  message: string
  pattern: RegExp
}

const UNSUPPORTED_PATTERNS: UnsupportedMatch[] = [
  {
    reason: 'frontmatter',
    message: 'Frontmatter is only editable in source mode.',
    // Why: Tiptap markdown support is beta and frontmatter is often consumed by
    // static-site tooling. Falling back to source mode avoids silently dropping
    // metadata that rich mode does not explicitly own.
    pattern: /^(?:---|\+\+\+)\r?\n[\s\S]*?\r?\n(?:---|\+\+\+)(?:\r?\n|$)/
  },
  {
    reason: 'jsx',
    message: 'JSX or MDX content is only editable in source mode.',
    // Why: uppercase tags are a strong MDX/JSX signal, and those files usually
    // carry component semantics that the markdown editor does not own. Raw HTML
    // is intentionally allowed because blocking ordinary .md files with common
    // inline tags proved too disruptive; source mode remains the fallback if a
    // specific document does not round-trip the way the user expects.
    pattern: /<[A-Z][\w.]*(?:\s[^<>]*)?\/?>/
  },
  {
    reason: 'reference-links',
    message: 'Reference-style links are only editable in source mode.',
    pattern: /^\[[^\]]+\]:\s+\S+/m
  },
  {
    reason: 'footnotes',
    message: 'Footnotes are only editable in source mode.',
    pattern: /^\[\^[^\]]+\]:\s+/m
  },
  {
    reason: 'tables',
    message: 'Markdown tables are only editable in source mode.',
    // Why: the current rich-mode extension set does not include table nodes, so
    // Tiptap collapses GFM tables instead of round-tripping them verbatim.
    pattern: /^(?:\|?.+\|.+\|?.*)\r?\n\|?(?:\s*:?-{1,}:?\s*\|){1,}\s*:?-{1,}:?\s*\|?/m
  }
]

export function getMarkdownRichModeUnsupportedMessage(content: string): string | null {
  const contentWithoutCode = stripMarkdownCode(content)

  for (const matcher of UNSUPPORTED_PATTERNS) {
    if (matcher.pattern.test(contentWithoutCode)) {
      return matcher.message
    }
  }

  return null
}

function stripMarkdownCode(content: string): string {
  const lines = content.split(/\r?\n/)
  const sanitizedLines: string[] = []
  let activeFence: '`' | '~' | null = null

  for (const line of lines) {
    const fenceMatch = line.match(/^\s*(`{3,}|~{3,})/)
    if (fenceMatch) {
      const fenceMarker = fenceMatch[1][0] as '`' | '~'
      activeFence = activeFence === fenceMarker ? null : fenceMarker
      sanitizedLines.push('')
      continue
    }

    if (activeFence) {
      sanitizedLines.push('')
      continue
    }

    sanitizedLines.push(line.replace(/`+[^`\n]*`+/g, ''))
  }

  return sanitizedLines.join('\n')
}
