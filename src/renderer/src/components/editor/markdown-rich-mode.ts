import { getRichMarkdownRoundTripOutput } from './markdown-round-trip'
import { extractFrontMatter } from './markdown-frontmatter'

export type MarkdownRichModeUnsupportedReason =
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
    reason: 'html-or-jsx',
    message: 'Editable only in code mode because this file contains HTML, JSX, or MDX.',
    // Why: the rich editor preserves common embedded markup via placeholder
    // tokens before parsing, but any HTML shape that still fails round-trip
    // must fall back instead of risking silent source corruption.
    pattern: /<\/?[A-Za-z][\w.:-]*(?:\s[^<>]*)?\/?>|<!--[\s\S]*?-->/
  },
  {
    reason: 'reference-links',
    message: 'Editable only in code mode because this file contains reference-style links.',
    pattern: /^\[[^\]]+\]:\s+\S+/m
  },
  {
    reason: 'footnotes',
    message: 'Editable only in code mode because this file contains footnotes.',
    pattern: /^\[\^[^\]]+\]:\s+/m
  }
]

export function getMarkdownRichModeUnsupportedMessage(content: string): string | null {
  // Why: front-matter is handled externally — stripped before the rich editor
  // sees the content and displayed as a read-only block. Only the body needs
  // to pass the unsupported-content checks.
  const fm = extractFrontMatter(content)
  const body = fm ? fm.body : content

  const contentWithoutCode = stripMarkdownCode(body)

  // Why: run cheap regex checks first. If no unsupported syntax is detected,
  // rich mode is safe — no need for the expensive round-trip check. The
  // round-trip (which synchronously creates a throwaway TipTap editor, parses
  // the full document, and serializes it back) is only needed as a second
  // opinion when HTML is detected, to verify the HTML survives the round-trip
  // before blocking the user from rich mode.
  const htmlMatcher = UNSUPPORTED_PATTERNS.find((m) => m.reason === 'html-or-jsx')
  const hasHtml = htmlMatcher && htmlMatcher.pattern.test(contentWithoutCode)

  for (const matcher of UNSUPPORTED_PATTERNS) {
    if (matcher.reason === 'html-or-jsx') {
      continue
    }
    if (matcher.pattern.test(contentWithoutCode)) {
      return matcher.message
    }
  }

  if (hasHtml) {
    // Why: the round-trip check creates a throwaway TipTap Editor synchronously
    // on the main thread. For large files this blocks for seconds, so we skip it and conservatively block rich mode for HTML files
    // above this threshold.
    const roundTripOutput = body.length <= 50_000 ? getRichMarkdownRoundTripOutput(body) : null
    if (roundTripOutput && preservesEmbeddedHtml(contentWithoutCode, roundTripOutput)) {
      return null
    }
    return htmlMatcher!.message
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
