import { getRichMarkdownRoundTripOutput } from './markdown-round-trip'
import { extractFrontMatter } from './markdown-frontmatter'
import { translate } from '@/i18n/i18n'

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
    get message() {
      return translate(
        'auto.components.editor.markdown.rich.mode.57128b73e1',
        'Editable only in code mode because this file contains HTML, JSX, or MDX.'
      )
    },
    // Why: the rich editor preserves common embedded markup via placeholder
    // tokens before parsing, but any HTML shape that still fails round-trip
    // must fall back instead of risking silent source corruption.
    pattern: /<\/?[A-Za-z][\w.:-]*(?:\s[^<>]*)?\/?>|<!--[\s\S]*?-->/
  },
  {
    reason: 'reference-links',
    get message() {
      return translate(
        'auto.components.editor.markdown.rich.mode.2fd2b44073',
        'Editable only in code mode because this file contains reference-style links.'
      )
    },
    pattern: /^\[[^\]]+\]:\s+\S+/m
  },
  {
    reason: 'footnotes',
    get message() {
      return translate(
        'auto.components.editor.markdown.rich.mode.7a8ce7c7da',
        'Editable only in code mode because this file contains footnotes.'
      )
    },
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
  let sanitized = ''
  let activeFence: '`' | '~' | null = null
  let lineStart = 0

  for (let index = 0; index <= content.length; index += 1) {
    if (index < content.length && content.charCodeAt(index) !== 10) {
      continue
    }
    const lineEnd = index > lineStart && content.charCodeAt(index - 1) === 13 ? index - 1 : index
    const line = content.slice(lineStart, lineEnd)
    const fenceMatch = line.match(/^\s*(`{3,}|~{3,})/)
    if (fenceMatch) {
      const fenceMarker = fenceMatch[1][0] as '`' | '~'
      activeFence = activeFence === fenceMarker ? null : fenceMarker
    } else if (!activeFence) {
      sanitized += line.replace(/`+[^`\n]*`+/g, '')
    }

    if (index < content.length) {
      sanitized += '\n'
    }
    lineStart = index + 1
  }

  return sanitized
}

function preservesEmbeddedHtml(contentWithoutCode: string, roundTripOutput: string): boolean {
  let searchIndex = 0
  return forEachEmbeddedHtmlFragment(contentWithoutCode, (fragment) => {
    const foundIndex = roundTripOutput.indexOf(fragment, searchIndex)
    if (foundIndex === -1) {
      return false
    }
    searchIndex = foundIndex + fragment.length
    return true
  })
}

function forEachEmbeddedHtmlFragment(
  content: string,
  visit: (fragment: string) => boolean
): boolean {
  for (let index = 0; index < content.length; index++) {
    if (content.charCodeAt(index) !== 60) {
      continue
    }

    let fragmentEnd: number | null = null
    if (content.startsWith('<!--', index)) {
      const commentEnd = content.indexOf('-->', index + 4)
      fragmentEnd = commentEnd === -1 ? null : commentEnd + 3
    } else {
      fragmentEnd = getHtmlTagEnd(content, index)
    }

    if (fragmentEnd === null) {
      continue
    }

    if (!visit(content.slice(index, fragmentEnd))) {
      return false
    }
    index = fragmentEnd - 1
  }

  return true
}

function getHtmlTagEnd(content: string, startIndex: number): number | null {
  let index = startIndex + 1

  if (content.charCodeAt(index) === 47) {
    index++
  }

  if (!isHtmlTagNameStart(content.charCodeAt(index))) {
    return null
  }
  index++

  while (isHtmlTagNamePart(content.charCodeAt(index))) {
    index++
  }

  const nextCode = content.charCodeAt(index)
  if (nextCode === 62) {
    return index + 1
  }
  if (nextCode === 47 && content.charCodeAt(index + 1) === 62) {
    return index + 2
  }
  if (!isHtmlWhitespace(nextCode)) {
    return null
  }

  index++
  while (index < content.length) {
    const code = content.charCodeAt(index)
    if (code === 60) {
      return null
    }
    if (code === 62) {
      return index + 1
    }
    index++
  }

  return null
}

function isHtmlTagNameStart(code: number): boolean {
  return (code >= 65 && code <= 90) || (code >= 97 && code <= 122)
}

function isHtmlTagNamePart(code: number): boolean {
  return (
    isHtmlTagNameStart(code) ||
    (code >= 48 && code <= 57) ||
    code === 95 ||
    code === 46 ||
    code === 58 ||
    code === 45
  )
}

function isHtmlWhitespace(code: number): boolean {
  return code === 9 || code === 10 || code === 11 || code === 12 || code === 13 || code === 32
}
