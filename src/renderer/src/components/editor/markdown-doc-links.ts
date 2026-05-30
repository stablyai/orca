import type { MarkdownDocument } from '../../../../shared/types'
import { slugMarkdownHeading } from './markdown-heading-slug'

export const MARKDOWN_DOC_LINK_PREFIX = '#orca-doc-link='

type MarkdownTextNode = {
  type: 'text'
  value: string
}

type MarkdownLinkNode = {
  type: 'link'
  url: string
  title: null
  children: MarkdownTextNode[]
}

type MarkdownNode = {
  type: string
  value?: string
  children?: MarkdownNode[]
}

export type MarkdownDocLinkTextPart =
  | { type: 'text'; value: string }
  | { type: 'docLink'; target: string; label: string }

export type ParsedMarkdownDocLink = {
  target: string
  label: string
  alias: string | null
}

export type MarkdownDocumentIndex = {
  byName: Map<string, MarkdownDocument[]>
  byRelativePath: Map<string, MarkdownDocument[]>
  byRelativePathWithoutExtension: Map<string, MarkdownDocument[]>
}

export type MarkdownDocLinkResolution =
  | { status: 'resolved'; document: MarkdownDocument }
  | { status: 'missing' }
  | { status: 'ambiguous'; matches: MarkdownDocument[] }

export function stripMarkdownExtension(value: string): string {
  const lower = value.toLowerCase()
  for (const extension of ['.markdown', '.mdx', '.md']) {
    if (lower.endsWith(extension)) {
      return value.slice(0, -extension.length)
    }
  }
  return value
}

function getMarkdownDocLinkDocumentTarget(target: string): string {
  const hashIndex = target.indexOf('#')
  if (hashIndex <= 0) {
    return target
  }
  // Why: Obsidian-style [[note#Heading]] links resolve the document first;
  // the heading fragment is applied only after the file target is known.
  return target.slice(0, hashIndex)
}

export function getMarkdownDocLinkAnchor(target: string): string | null {
  const hashIndex = target.indexOf('#')
  if (hashIndex === -1 || hashIndex === target.length - 1) {
    return null
  }
  const anchor = target.slice(hashIndex + 1).trim()
  return anchor ? slugMarkdownHeading(anchor) : null
}

function normalizeDocLinkKey(value: string): string {
  let normalized = value.trim().replaceAll('\\', '/')
  while (normalized.startsWith('./')) {
    normalized = normalized.slice(2)
  }
  return normalized.toLowerCase()
}

function addIndexedDocument(
  map: Map<string, MarkdownDocument[]>,
  key: string,
  document: MarkdownDocument
): void {
  const existing = map.get(key)
  if (existing) {
    existing.push(document)
  } else {
    map.set(key, [document])
  }
}

function resolveMatches(matches: MarkdownDocument[] | undefined): MarkdownDocLinkResolution | null {
  if (!matches) {
    return null
  }
  return matches.length === 1
    ? { status: 'resolved', document: matches[0] }
    : { status: 'ambiguous', matches }
}

export function createMarkdownDocumentIndex(documents: MarkdownDocument[]): MarkdownDocumentIndex {
  const byName = new Map<string, MarkdownDocument[]>()
  const byRelativePath = new Map<string, MarkdownDocument[]>()
  const byRelativePathWithoutExtension = new Map<string, MarkdownDocument[]>()

  for (const document of documents) {
    addIndexedDocument(byName, normalizeDocLinkKey(document.name), document)
    addIndexedDocument(byRelativePath, normalizeDocLinkKey(document.relativePath), document)
    addIndexedDocument(
      byRelativePathWithoutExtension,
      normalizeDocLinkKey(stripMarkdownExtension(document.relativePath)),
      document
    )
  }

  return { byName, byRelativePath, byRelativePathWithoutExtension }
}

export function resolveMarkdownDocLink(
  target: string,
  index: MarkdownDocumentIndex
): MarkdownDocLinkResolution {
  const normalizedTarget = normalizeDocLinkKey(getMarkdownDocLinkDocumentTarget(target))
  const extensionlessTarget = stripMarkdownExtension(normalizedTarget)

  // Why: exact relative path must be checked before the extensionless lookup
  // so that [[docs/guide.md]] resolves uniquely even when docs/guide.mdx also
  // exists (both share the extensionless key "docs/guide").
  const relativeWithExtension = resolveMatches(index.byRelativePath.get(normalizedTarget))
  if (relativeWithExtension) {
    return relativeWithExtension
  }

  const relativeWithoutExtension = resolveMatches(
    index.byRelativePathWithoutExtension.get(extensionlessTarget)
  )
  if (relativeWithoutExtension) {
    return relativeWithoutExtension
  }

  if (!normalizedTarget.includes('/')) {
    const byName = resolveMatches(index.byName.get(extensionlessTarget))
    if (byName) {
      return byName
    }
  }

  return { status: 'missing' }
}

export function parseMarkdownDocLink(rawTarget: string): ParsedMarkdownDocLink | null {
  const separatorIndex = rawTarget.indexOf('|')
  const target =
    separatorIndex === -1 ? rawTarget.trim() : rawTarget.slice(0, separatorIndex).trim()
  const alias = separatorIndex === -1 ? null : rawTarget.slice(separatorIndex + 1).trim() || null

  if (!target || /[\r\n[\]]/.test(target) || (alias !== null && /[\r\n[\]]/.test(alias))) {
    return null
  }
  if (separatorIndex !== -1 && alias === null) {
    return null
  }

  return {
    target,
    alias,
    label: alias ?? target
  }
}

export function getMarkdownDocLinkTarget(rawTarget: string): string | null {
  return parseMarkdownDocLink(rawTarget)?.target ?? null
}

export function formatMarkdownDocLinkBody(target: string, alias?: string | null): string {
  return alias ? `${target}|${alias}` : target
}

export function formatMarkdownDocLink(target: string, alias?: string | null): string {
  return `[[${formatMarkdownDocLinkBody(target, alias)}]]`
}

export function splitMarkdownDocLinkText(value: string): MarkdownDocLinkTextPart[] {
  const parts: MarkdownDocLinkTextPart[] = []
  let position = 0

  while (position < value.length) {
    const start = value.indexOf('[[', position)
    if (start === -1) {
      parts.push({ type: 'text', value: value.slice(position) })
      break
    }

    const end = value.indexOf(']]', start + 2)
    if (end === -1) {
      parts.push({ type: 'text', value: value.slice(position) })
      break
    }

    const link = parseMarkdownDocLink(value.slice(start + 2, end))
    if (!link) {
      parts.push({ type: 'text', value: value.slice(position, end + 2) })
      position = end + 2
      continue
    }

    if (start > position) {
      parts.push({ type: 'text', value: value.slice(position, start) })
    }
    parts.push({ type: 'docLink', target: link.target, label: link.label })
    position = end + 2
  }

  return parts.length === 0 ? [{ type: 'text', value }] : parts
}

export function createMarkdownDocLinkHref(target: string): string {
  return `${MARKDOWN_DOC_LINK_PREFIX}${encodeURIComponent(target)}`
}

export function parseMarkdownDocLinkHref(href: string | undefined): string | null {
  if (!href?.startsWith(MARKDOWN_DOC_LINK_PREFIX)) {
    return null
  }
  try {
    return decodeURIComponent(href.slice(MARKDOWN_DOC_LINK_PREFIX.length))
  } catch {
    return null
  }
}

function createDocLinkNode(target: string, label: string): MarkdownLinkNode {
  return {
    type: 'link',
    url: createMarkdownDocLinkHref(target),
    title: null,
    children: [{ type: 'text', value: label }]
  }
}

function transformChildren(node: MarkdownNode): void {
  if (!node.children || node.type === 'link' || node.type === 'image') {
    return
  }

  const nextChildren: MarkdownNode[] = []
  for (const child of node.children) {
    if (child.type === 'text' && child.value !== undefined) {
      for (const part of splitMarkdownDocLinkText(child.value)) {
        nextChildren.push(
          part.type === 'text'
            ? { type: 'text', value: part.value }
            : createDocLinkNode(part.target, part.label)
        )
      }
    } else {
      transformChildren(child)
      nextChildren.push(child)
    }
  }

  node.children = nextChildren
}

export function remarkMarkdownDocLinks(): (tree: MarkdownNode) => void {
  return (tree) => transformChildren(tree)
}
