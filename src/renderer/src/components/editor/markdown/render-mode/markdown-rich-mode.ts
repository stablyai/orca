import { defaultSchema } from 'rehype-sanitize'
import { normalizeDetailsOpeningTag } from '../../rich-markdown/details/details-markdown-html'
import {
  getRichMarkdownPassthroughOutput,
  getRichMarkdownRoundTripOutput,
  hasRichMarkdownReferenceDefinition
} from './markdown-round-trip'
import { extractFrontMatter } from '../source-scanning/markdown-frontmatter'
import { stripMarkdownCode } from '../source-scanning/markdown-code-and-comment-scan'
import {
  canRenderMarkdownAtSize,
  exceedsMarkdownRenderOverrideSizeLimit
} from './markdown-rich-size-limit'
import { translate } from '@/i18n/i18n'
import { encodeRawMarkdownHtmlForRichEditor } from '../../rich-markdown/raw-source/raw-markdown-html'
import { createRichMarkdownEditorCodec } from '../../rich-markdown/document/rich-markdown-source-transport'
import {
  FOOTNOTE_CANDIDATE_PATTERN,
  hasFootnoteCandidate,
  hasNonFootnoteReferenceLinkCandidate,
  preservesFootnotes
} from '../../rich-markdown/footnotes/rich-markdown-footnote-eligibility'

// Why: eligibility re-runs on every edit, so this caps full-document parser cost.
const FULL_ROUND_TRIP_MAX_CODE_UNITS = 50_000

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

export type MarkdownRichModeEligibility = {
  exceedsSizeLimit: boolean
  unsupportedMessage: string | null
}

/** Cache this pure document decision only; localized messages must be resolved per read. */
export type MarkdownRichModeEligibilityDecision = {
  exceedsSizeLimit: boolean
  unsupportedReason: MarkdownRichModeUnsupportedReason | null
}

const KNOWN_MARKDOWN_HTML_TAG_NAMES = new Set(defaultSchema.tagNames ?? [])

const UNSUPPORTED_PATTERNS: UnsupportedMatch[] = [
  {
    reason: 'html-or-jsx',
    get message() {
      return translate(
        'auto.components.editor.markdown.rich.mode.57128b73e1',
        'Editable only in code mode because this file contains HTML, JSX, or MDX.'
      )
    },
    // Fall back when placeholder-protected HTML still fails round-trip to avoid silently corrupting source.
    pattern: /<\/?[A-Za-z][\w.:-]*(?:\s[^<>]*)?\/?>/
  },
  {
    reason: 'footnotes',
    get message() {
      return translate(
        'auto.components.editor.markdown.rich.mode.7a8ce7c7da',
        'Editable only in code mode because this file contains footnotes.'
      )
    },
    pattern: FOOTNOTE_CANDIDATE_PATTERN
  },
  {
    reason: 'reference-links',
    get message() {
      return translate(
        'auto.components.editor.markdown.rich.mode.2fd2b44073',
        'Editable only in code mode because this file contains reference-style links.'
      )
    },
    // Why: `[label]: ` also opens prose, so the rich parser confirms a real definition.
    pattern: /^\[[^\]]+\]:\s+\S+/m
  }
]

export function getMarkdownRichModeUnsupportedMessage(content: string): string | null {
  return resolveMarkdownRichModeUnsupportedMessage(getMarkdownRichModeUnsupportedReason(content))
}

/** Resolve through the getter so messages follow the active UI language. */
export function resolveMarkdownRichModeUnsupportedMessage(
  reason: MarkdownRichModeUnsupportedReason | null
): string | null {
  if (reason === null) {
    return null
  }
  return UNSUPPORTED_PATTERNS.find((matcher) => matcher.reason === reason)?.message ?? null
}

export function getMarkdownRichModeUnsupportedReason(
  content: string
): MarkdownRichModeUnsupportedReason | null {
  // Front matter is displayed separately as read-only; only its body enters rich editing.
  const fm = extractFrontMatter(content)
  const body = fm ? fm.body : content

  const contentWithoutCode = stripMarkdownCode(body)
  const htmlPattern = UNSUPPORTED_PATTERNS[0].pattern
  const refLinksPattern = UNSUPPORTED_PATTERNS[2].pattern
  const hasHtml = hasHtmlOrJsx(contentWithoutCode, htmlPattern)
  const hasFootnotes = hasFootnoteCandidate(contentWithoutCode)

  if (
    body.length > FULL_ROUND_TRIP_MAX_CODE_UNITS
      ? hasNonFootnoteReferenceLinkCandidate(contentWithoutCode)
      : (refLinksPattern.test(contentWithoutCode) ||
          (hasFootnotes && hasNonFootnoteReferenceLinkCandidate(contentWithoutCode))) &&
        hasRichMarkdownReferenceDefinition(body)
  ) {
    return 'reference-links'
  }

  if (hasHtml || hasFootnotes) {
    const roundTripOutput =
      body.length > FULL_ROUND_TRIP_MAX_CODE_UNITS
        ? getLargeMarkdownRoundTripOutput(body, hasHtml ? htmlPattern : null)
        : getRichMarkdownRoundTripOutput(body)
    if (
      hasFootnotes &&
      (!roundTripOutput ||
        !preservesFootnotes(
          contentWithoutCode,
          roundTripOutput,
          stripMarkdownCode(roundTripOutput)
        ))
    ) {
      return 'footnotes'
    }
    if (
      hasHtml &&
      (!roundTripOutput || !preservesEmbeddedHtml(contentWithoutCode, roundTripOutput))
    ) {
      return 'html-or-jsx'
    }
  }

  return null
}

function getLargeMarkdownRoundTripOutput(body: string, htmlPattern: RegExp | null): string | null {
  try {
    const codec = createRichMarkdownEditorCodec()
    const encoded = encodeRawMarkdownHtmlForRichEditor(body, codec, { htmlSuperscriptLinks: true })
    // Remaining HTML needs DOM parsing; keep large editable toggles on the bounded fallback.
    if (htmlPattern && hasHtmlOrJsx(stripMarkdownCode(encoded), htmlPattern)) {
      return null
    }
    return getRichMarkdownPassthroughOutput(encoded, codec)
  } catch {
    return null
  }
}

export function getMarkdownRichModeEligibilityDecision({
  content,
  sizeOverridden
}: {
  content: string
  sizeOverridden: boolean
}): MarkdownRichModeEligibilityDecision {
  // Past the hard cap neither mode renders rich, so the unsupported-syntax scan is moot.
  if (exceedsMarkdownRenderOverrideSizeLimit(content)) {
    return { exceedsSizeLimit: true, unsupportedReason: null }
  }
  return {
    exceedsSizeLimit: !canRenderMarkdownAtSize(content, sizeOverridden),
    unsupportedReason: getMarkdownRichModeUnsupportedReason(content)
  }
}

export function getMarkdownRichModeEligibility(params: {
  content: string
  sizeOverridden: boolean
}): MarkdownRichModeEligibility {
  const decision = getMarkdownRichModeEligibilityDecision(params)
  return {
    exceedsSizeLimit: decision.exceedsSizeLimit,
    unsupportedMessage: resolveMarkdownRichModeUnsupportedMessage(decision.unsupportedReason)
  }
}

function hasHtmlOrJsx(content: string, pattern: RegExp): boolean {
  // A missing closer after the first opener rules out every later opener.
  const commentStart = content.indexOf('<!--')
  if (commentStart !== -1 && content.includes('-->', commentStart + 4)) {
    return true
  }
  for (const match of content.matchAll(new RegExp(pattern, 'g'))) {
    if (isHtmlOrJsxFragment(match[0])) {
      return true
    }
  }
  return false
}

function isHtmlOrJsxFragment(fragment: string): boolean {
  if (fragment.startsWith('</')) {
    return true
  }

  const tagMatch = fragment.match(/^<([A-Za-z][\w.:-]*)/)
  const tagName = tagMatch?.[1]
  if (!tagName) {
    return false
  }

  const suffix = fragment.slice(tagName.length + 1, -1)
  return suffix.length > 0 || KNOWN_MARKDOWN_HTML_TAG_NAMES.has(tagName.toLowerCase())
}

function preservesEmbeddedHtml(contentWithoutCode: string, roundTripOutput: string): boolean {
  let searchIndex = 0
  return forEachEmbeddedHtmlFragment(contentWithoutCode, (fragment) => {
    const normalized = normalizeDetailsOpeningTag(fragment)
    const exactIndex = roundTripOutput.indexOf(fragment, searchIndex)
    // Details serialization adds Orca's class and canonicalizes supported attributes.
    const normalizedIndex =
      normalized === fragment ? -1 : roundTripOutput.indexOf(normalized, searchIndex)
    const useNormalized =
      normalizedIndex !== -1 && (exactIndex === -1 || normalizedIndex < exactIndex)
    const foundIndex = useNormalized ? normalizedIndex : exactIndex
    if (foundIndex === -1) {
      return false
    }
    searchIndex = foundIndex + (useNormalized ? normalized.length : fragment.length)
    return true
  })
}

function forEachEmbeddedHtmlFragment(
  content: string,
  visit: (fragment: string) => boolean
): boolean {
  const lastCommentClose = content.lastIndexOf('-->')
  for (let index = 0; index < content.length; index++) {
    if (content.charCodeAt(index) !== 60) {
      continue
    }

    let fragmentEnd: number | null = null
    if (content.startsWith('<!--', index)) {
      const commentEnd = index + 4 <= lastCommentClose ? content.indexOf('-->', index + 4) : -1
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
