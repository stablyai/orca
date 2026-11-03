import {
  createNativeChatFileHref,
  routeNativeChatHref
} from '../../../../shared/native-chat/native-chat-href-routing'
import {
  formatFileLinkLocation,
  parseFileLinkLocation
} from '../../../../shared/file-link-location'
import {
  extractTerminalFileLinkReadings,
  extractTerminalFileLinks,
  type ParsedTerminalFileLink
} from '../../../../shared/terminal-links'
import { ROOTED_PATH_START_PATTERN } from '../../../../shared/terminal-file-link-detection-ranges'
import { preferLongestNonOverlappingMatches } from '@/lib/longest-non-overlapping-matches'

type MarkdownNode = {
  type: string
  value?: string
  url?: string
  children?: MarkdownNode[]
}

/** Whether a detected path names a file on the chat's host; the terminal's own check. */
export type FileLinkExists = (link: ParsedTerminalFileLink) => boolean

function looksLikeFilePath(link: ParsedTerminalFileLink, isProse: boolean): boolean {
  const hasRootedPrefix = ROOTED_PATH_START_PATTERN.test(link.pathText)
  const hasLineSuffix = link.line !== null || link.column !== null
  const hasAlphabeticExtension = /\.[\p{L}][\p{L}\p{N}\p{M}_+-]*$/u.test(link.pathText)
  const hasPathExtension = /\.[\p{L}\p{N}][\p{L}\p{N}\p{M}_+-]*$/u.test(link.pathText)
  return hasRootedPrefix || hasLineSuffix || (isProse ? hasPathExtension : hasAlphabeticExtension)
}

// Require separators in prose; exact bare inline-code tokens are checked separately.
function isLinkifiableFile(link: ParsedTerminalFileLink, isProse: boolean): boolean {
  return (
    /[\\/]/.test(link.pathText) &&
    looksLikeFilePath(link, isProse) &&
    routeNativeChatHref(link.displayText).kind === 'file'
  )
}

// Underline only host-confirmed paths; choose the longest existing candidate when spaced spans overlap tokens.
function selectExistingLinks(
  candidates: ParsedTerminalFileLink[],
  exists: FileLinkExists
): ParsedTerminalFileLink[] {
  return preferLongestNonOverlappingMatches(
    candidates.filter((link) => exists(link)),
    {
      length: (link) => link.endIndex - link.startIndex,
      overlaps: (left, right) =>
        left.startIndex < right.endIndex && right.startIndex < left.endIndex,
      compareStart: (left, right) => left.startIndex - right.startIndex
    }
  )
}

const SAFE_LEADING_BOUNDARY_PATTERN = /[\s([{'",;=]/
const SAFE_TRAILING_BOUNDARY_PATTERN = /[\s)\]}>'",;.:。！？，、；：]/
const SENTENCE_PATH_PUNCTUATION_PATTERN =
  /\.[\p{L}\p{N}][\p{L}\p{N}\p{M}_+-]*([!?—。！？，、；：])/gu
const QUOTED_TEXT_PATTERN = /"([^"\r\n]+)"|'([^"'\r\n]+)'/gu
const MAX_DASHED_PROSE_WORD_LENGTH = 32

function hasBoundedProseAfterDash(value: string, startIndex: number): boolean {
  const endIndex = Math.min(value.length, startIndex + MAX_DASHED_PROSE_WORD_LENGTH)
  for (let index = startIndex; index < endIndex; index += 1) {
    const char = value[index]
    if (!char || SAFE_TRAILING_BOUNDARY_PATTERN.test(char)) {
      return true
    }
    if (char === '/' || char === '\\') {
      return false
    }
  }
  return endIndex === value.length
}

function isSafeTrailingBoundary(value: string, endIndex: number): boolean {
  const boundary = value[endIndex]
  if (boundary === undefined || SAFE_TRAILING_BOUNDARY_PATTERN.test(boundary)) {
    return true
  }
  if (boundary === '!' || boundary === '?') {
    const next = value[endIndex + 1]
    return next === undefined || SAFE_TRAILING_BOUNDARY_PATTERN.test(next)
  }
  if (boundary === '—') {
    return hasBoundedProseAfterDash(value, endIndex + 1)
  }
  return false
}

function hasPartialPathBoundary(value: string, link: ParsedTerminalFileLink): boolean {
  const before = value[link.startIndex - 1]
  return (
    (before !== undefined && !SAFE_LEADING_BOUNDARY_PATTERN.test(before)) ||
    !isSafeTrailingBoundary(value, link.endIndex)
  )
}

// Wrap parsed locations rather than raw file-URI display text so navigation receives the literal path.
function createFileLinkNode(link: ParsedTerminalFileLink, child: MarkdownNode): MarkdownNode {
  return {
    type: 'link',
    url: createNativeChatFileHref(formatFileLinkLocation(link)),
    children: [child]
  }
}

function splitTextSegment(value: string, exists: FileLinkExists): MarkdownNode[] {
  const { links: textLinks, guesses } = extractTerminalFileLinkReadings(value)
  const links = selectExistingLinks(
    [...textLinks, ...guesses]
      .filter((link) => !hasPartialPathBoundary(value, link))
      .filter((link) => isLinkifiableFile(link, true)),
    exists
  )
  if (links.length === 0) {
    return [{ type: 'text', value }]
  }

  const children: MarkdownNode[] = []
  let cursor = 0
  for (const link of links) {
    if (link.startIndex > cursor) {
      children.push({ type: 'text', value: value.slice(cursor, link.startIndex) })
    }
    children.push(createFileLinkNode(link, { type: 'text', value: link.displayText }))
    cursor = link.endIndex
  }
  if (cursor < value.length) {
    children.push({ type: 'text', value: value.slice(cursor) })
  }
  return children
}

function splitUnquotedText(value: string, exists: FileLinkExists): MarkdownNode[] {
  const children: MarkdownNode[] = []
  let cursor = 0
  for (const match of value.matchAll(SENTENCE_PATH_PUNCTUATION_PATTERN)) {
    const punctuationIndex = (match.index ?? 0) + match[0].length - 1
    if (!isSafeTrailingBoundary(value, punctuationIndex)) {
      continue
    }
    children.push(...splitTextSegment(value.slice(cursor, punctuationIndex), exists))
    children.push({ type: 'text', value: value[punctuationIndex] })
    cursor = punctuationIndex + 1
  }
  if (cursor === 0) {
    return splitTextSegment(value, exists)
  }
  children.push(...splitTextSegment(value.slice(cursor), exists))
  return children
}

function exactFileLink(value: string, exists: FileLinkExists): ParsedTerminalFileLink | null {
  const exactLink = extractTerminalFileLinks(value).find(
    (link) => link.startIndex === 0 && link.endIndex === value.length
  )
  if (exactLink && isLinkifiableFile(exactLink, false)) {
    return exists(exactLink) ? exactLink : null
  }
  if (!/\s/.test(value)) {
    return null
  }
  const parsed = parseFileLinkLocation(value)
  if (!parsed) {
    return null
  }
  const looksLikePath =
    ROOTED_PATH_START_PATTERN.test(parsed.pathText) ||
    /[\\/]/.test(parsed.pathText) ||
    /\.[\p{L}][\p{L}\p{N}\p{M}_+-]*$/u.test(parsed.pathText)
  if (!looksLikePath) {
    return null
  }
  const explicitLink = {
    ...parsed,
    startIndex: 0,
    endIndex: value.length,
    displayText: value
  }
  return isLinkifiableFile(explicitLink, false) && exists(explicitLink) ? explicitLink : null
}

function splitTextNode(value: string, exists: FileLinkExists): MarkdownNode[] {
  const children: MarkdownNode[] = []
  let cursor = 0
  for (const match of value.matchAll(QUOTED_TEXT_PATTERN)) {
    const content = match[1] ?? match[2]
    const link = content ? exactFileLink(content, exists) : null
    if (!content || !link) {
      continue
    }
    const matchIndex = match.index ?? 0
    const quote = match[0][0]
    children.push(...splitUnquotedText(value.slice(cursor, matchIndex), exists))
    children.push({ type: 'text', value: quote })
    children.push(createFileLinkNode(link, { type: 'text', value: content }))
    children.push({ type: 'text', value: quote })
    cursor = matchIndex + match[0].length
  }
  if (cursor === 0) {
    return splitUnquotedText(value, exists)
  }
  children.push(...splitUnquotedText(value.slice(cursor), exists))
  return children
}

function inlineCodeFileLink(node: MarkdownNode, exists: FileLinkExists): MarkdownNode | null {
  const value = node.value?.trim()
  if (!value) {
    return null
  }
  // Dotted bare words still need separators, keeping versions/model names plain.
  const bare = extractTerminalFileLinks(value).find(
    (candidate) =>
      candidate.startIndex === 0 &&
      candidate.endIndex === value.length &&
      !/[\\/]/.test(candidate.pathText) &&
      (!candidate.pathText.includes('.') || looksLikeFilePath(candidate, false))
  )
  const link = bare ? (exists(bare) ? bare : null) : exactFileLink(value, exists)
  return link ? createFileLinkNode(link, node) : null
}

function transformFileLinks(node: MarkdownNode, exists: FileLinkExists): void {
  if (node.type === 'link') {
    const route = routeNativeChatHref(node.url)
    if (route.kind === 'file') {
      // Resolve URL syntax once before wrapping literal location text.
      node.url = createNativeChatFileHref(formatFileLinkLocation(route))
    }
    return
  }
  if (!node.children || node.type === 'image') {
    return
  }

  const children: MarkdownNode[] = []
  for (const child of node.children) {
    if (child.type === 'text' && child.value !== undefined) {
      children.push(...splitTextNode(child.value, exists))
      continue
    }
    if (child.type === 'inlineCode') {
      children.push(inlineCodeFileLink(child, exists) ?? child)
      continue
    }
    transformFileLinks(child, exists)
    children.push(child)
  }
  node.children = children
}

/** Explicit markdown links stay links; detected paths link only once `exists` confirms them. */
export function remarkNativeChatFileLinks(
  exists: FileLinkExists
): () => (tree: MarkdownNode) => void {
  return () => (tree) => transformFileLinks(tree, exists)
}
