import { canRoundTripRichMarkdown, getRichMarkdownRoundTripOutput } from './markdown-round-trip'

export type MarkdownRichModeUnsupportedReason =
  | 'frontmatter'
  | 'html-or-jsx'
  | 'reference-links'
  | 'footnotes'
  | 'other'

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
    reason: 'html-or-jsx',
    message: 'HTML, JSX, or MDX content is only editable in source mode.',
    // Why: the rich editor preserves common embedded markup via placeholder
    // tokens before parsing, but any HTML shape that still fails round-trip
    // must fall back instead of risking silent source corruption.
    pattern: /<\/?[A-Za-z][\w.:-]*(?:\s[^<>]*)?\/?>|<!--[\s\S]*?-->/
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
  }
]

export function getMarkdownRichModeUnsupportedMessage(content: string): string | null {
  const contentWithoutCode = stripMarkdownCode(content)

  const frontmatterMatcher = UNSUPPORTED_PATTERNS[0]
  if (frontmatterMatcher && frontmatterMatcher.pattern.test(contentWithoutCode)) {
    return frontmatterMatcher.message
  }

  if (canRoundTripRichMarkdown(content)) {
    return null
  }

  const htmlMatcher = UNSUPPORTED_PATTERNS[1]
  if (htmlMatcher && htmlMatcher.pattern.test(contentWithoutCode)) {
    const roundTripOutput = getRichMarkdownRoundTripOutput(content)
    if (roundTripOutput && preservesEmbeddedHtml(contentWithoutCode, roundTripOutput)) {
      return null
    }
  }

  for (const matcher of UNSUPPORTED_PATTERNS.slice(1)) {
    if (matcher.pattern.test(contentWithoutCode)) {
      return matcher.message
    }
  }

  // Why: Tiptap rewrites some harmless markdown spellings such as autolinks or
  // escaped angle brackets even when the rendered document stays equivalent.
  // Preview mode should stay editable unless we have a specific syntax we know
  // the editor will drop or reinterpret in a user-visible way.
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

function preservesEmbeddedHtml(contentWithoutCode: string, roundTripOutput: string): boolean {
  const htmlFragments =
    contentWithoutCode.match(/<!--[\s\S]*?-->|<\/?[A-Za-z][\w.:-]*(?:\s[^<>]*?)?\/?>/g) ?? []

  let searchIndex = 0
  for (const fragment of htmlFragments) {
    const foundIndex = roundTripOutput.indexOf(fragment, searchIndex)
    if (foundIndex === -1) {
      return false
    }
    searchIndex = foundIndex + fragment.length
  }

  return true
}
