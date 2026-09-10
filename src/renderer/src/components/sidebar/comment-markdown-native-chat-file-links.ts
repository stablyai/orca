import {
  createNativeChatFileHref,
  routeNativeChatHref
} from '../../../../shared/native-chat-href-routing'
import { parseFileLinkLocation } from '../../../../shared/file-link-location'
import { extractTerminalFileLinks, type ParsedTerminalFileLink } from '@/lib/terminal-links'

type MarkdownNode = {
  type: string
  value?: string
  url?: string
  children?: MarkdownNode[]
}

const ROOTED_PATH_PREFIX_PATTERN = /^(?:~[\\/]|\.{1,2}[\\/]|[\\/]|[A-Za-z]:[\\/])/

function isLinkifiableFile(link: ParsedTerminalFileLink, requireSeparator: boolean): boolean {
  const hasRootedPrefix = ROOTED_PATH_PREFIX_PATTERN.test(link.pathText)
  const hasLineSuffix = link.line !== null || link.column !== null
  const hasAlphabeticExtension = /\.[\p{L}][\p{L}\p{N}\p{M}_+-]*$/u.test(link.pathText)
  const hasPathExtension = /\.[\p{L}\p{N}][\p{L}\p{N}\p{M}_+-]*$/u.test(link.pathText)
  return (
    (!requireSeparator || /[\\/]/.test(link.pathText)) &&
    (hasRootedPrefix ||
      hasLineSuffix ||
      (requireSeparator ? hasPathExtension : hasAlphabeticExtension)) &&
    routeNativeChatHref(link.displayText).kind === 'file'
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

function createFileLinkNode(value: string, child: MarkdownNode): MarkdownNode {
  return {
    type: 'link',
    url: createNativeChatFileHref(value),
    children: [child]
  }
}

// Why: the terminal extractor spans "src/a.ts and src/b.ts" as one spaced path.
// An unrooted span holding a bare word or several linkable tokens is prose
// joining paths, so link the tokens on their own; a spaced folder name keeps
// every token path-shaped and stays one link.
function splitProseJoinedLinks(link: ParsedTerminalFileLink): ParsedTerminalFileLink[] {
  if (ROOTED_PATH_PREFIX_PATTERN.test(link.pathText)) {
    return [link]
  }
  const tokens = Array.from(link.displayText.matchAll(/\S+/g))
  const tokenLinks: ParsedTerminalFileLink[] = []
  for (const match of tokens) {
    const token = match[0]
    const exactLink = extractTerminalFileLinks(token).find(
      (candidate) => candidate.startIndex === 0 && candidate.endIndex === token.length
    )
    if (exactLink && isLinkifiableFile(exactLink, true)) {
      const startIndex = link.startIndex + (match.index ?? 0)
      tokenLinks.push({ ...exactLink, startIndex, endIndex: startIndex + token.length })
    }
  }
  const hasBareWord = tokens.some((match) => !/[\\/.]/.test(match[0]))
  return hasBareWord || tokenLinks.length > 1 ? tokenLinks : [link]
}

function splitTextSegment(value: string): MarkdownNode[] {
  const links = extractTerminalFileLinks(value)
    .filter((link) => !hasPartialPathBoundary(value, link))
    .filter((link) => isLinkifiableFile(link, true))
    .flatMap(splitProseJoinedLinks)
  if (links.length === 0) {
    return [{ type: 'text', value }]
  }

  const children: MarkdownNode[] = []
  let cursor = 0
  for (const link of links) {
    if (link.startIndex < cursor) {
      continue
    }
    if (link.startIndex > cursor) {
      children.push({ type: 'text', value: value.slice(cursor, link.startIndex) })
    }
    children.push(createFileLinkNode(link.displayText, { type: 'text', value: link.displayText }))
    cursor = link.endIndex
  }
  if (cursor < value.length) {
    children.push({ type: 'text', value: value.slice(cursor) })
  }
  return children
}

function splitUnquotedText(value: string): MarkdownNode[] {
  const children: MarkdownNode[] = []
  let cursor = 0
  for (const match of value.matchAll(SENTENCE_PATH_PUNCTUATION_PATTERN)) {
    const punctuationIndex = (match.index ?? 0) + match[0].length - 1
    if (!isSafeTrailingBoundary(value, punctuationIndex)) {
      continue
    }
    children.push(...splitTextSegment(value.slice(cursor, punctuationIndex)))
    children.push({ type: 'text', value: value[punctuationIndex] })
    cursor = punctuationIndex + 1
  }
  if (cursor === 0) {
    return splitTextSegment(value)
  }
  children.push(...splitTextSegment(value.slice(cursor)))
  return children
}

function exactFileLink(value: string, allowSpacedRelative: boolean): ParsedTerminalFileLink | null {
  const exactLink = extractTerminalFileLinks(value).find(
    (link) => link.startIndex === 0 && link.endIndex === value.length
  )
  if (exactLink && isLinkifiableFile(exactLink, false)) {
    return exactLink
  }
  if (!allowSpacedRelative || !/\s/.test(value)) {
    return null
  }
  const parsed = parseFileLinkLocation(value)
  if (!parsed) {
    return null
  }
  const hasPathShape =
    ROOTED_PATH_PREFIX_PATTERN.test(parsed.pathText) ||
    /[\\/]/.test(parsed.pathText) ||
    /\.[\p{L}][\p{L}\p{N}\p{M}_+-]*$/u.test(parsed.pathText)
  if (!hasPathShape) {
    return null
  }
  const explicitLink = {
    ...parsed,
    startIndex: 0,
    endIndex: value.length,
    displayText: value
  }
  return isLinkifiableFile(explicitLink, false) ? explicitLink : null
}

function splitTextNode(value: string): MarkdownNode[] {
  const children: MarkdownNode[] = []
  let cursor = 0
  for (const match of value.matchAll(QUOTED_TEXT_PATTERN)) {
    const content = match[1] ?? match[2]
    if (!content || !exactFileLink(content, true)) {
      continue
    }
    const matchIndex = match.index ?? 0
    const quote = match[0][0]
    children.push(...splitUnquotedText(value.slice(cursor, matchIndex)))
    children.push({ type: 'text', value: quote })
    children.push(createFileLinkNode(content, { type: 'text', value: content }))
    children.push({ type: 'text', value: quote })
    cursor = matchIndex + match[0].length
  }
  if (cursor === 0) {
    return splitUnquotedText(value)
  }
  children.push(...splitUnquotedText(value.slice(cursor)))
  return children
}

function inlineCodeFileLink(node: MarkdownNode): MarkdownNode | null {
  const value = node.value?.trim()
  if (!value) {
    return null
  }
  return exactFileLink(value, true) ? createFileLinkNode(value, node) : null
}

function transformFileLinks(node: MarkdownNode): void {
  if (node.type === 'link') {
    if (node.url && routeNativeChatHref(node.url).kind === 'file') {
      node.url = createNativeChatFileHref(node.url)
    }
    return
  }
  if (!node.children || node.type === 'image') {
    return
  }

  const children: MarkdownNode[] = []
  for (const child of node.children) {
    if (child.type === 'text' && child.value !== undefined) {
      children.push(...splitTextNode(child.value))
      continue
    }
    if (child.type === 'inlineCode') {
      children.push(inlineCodeFileLink(child) ?? child)
      continue
    }
    transformFileLinks(child)
    children.push(child)
  }
  node.children = children
}

export function remarkNativeChatFileLinks(): (tree: MarkdownNode) => void {
  return (tree) => transformFileLinks(tree)
}
