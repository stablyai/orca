import type { MarkdownDocument } from '../../../../shared/types'

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
  const normalizedTarget = normalizeDocLinkKey(target)
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

export function getMarkdownDocLinkTarget(rawTarget: string): string | null {
  const target = rawTarget.trim()
  if (!target || /[\r\n[\]|]/.test(target)) {
    return null
  }
  return target
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

    const target = getMarkdownDocLinkTarget(value.slice(start + 2, end))
    if (!target) {
      parts.push({ type: 'text', value: value.slice(position, end + 2) })
      position = end + 2
      continue
    }

    if (start > position) {
      parts.push({ type: 'text', value: value.slice(position, start) })
    }
    parts.push({ type: 'docLink', target, label: target })
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
