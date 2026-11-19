// Definitions and footnotes reach across blocks; each block gets what it references so blocks
// still render on their own, numbered as the whole document would number them.

import type { Definition, FootnoteReference, Nodes, Root } from 'mdast'
import type { Element, Root as HastRoot } from 'hast'

/** A definition the document makes, as written. */
export type MarkdownDefinition = {
  kind: 'link' | 'footnote'
  identifier: string
  label: string
  /** The definition's own source. */
  source: string
  /** Where it starts in the document. */
  start: number
  /** Link definitions as parsed, for blocks rendered from a cached tree. */
  node?: Definition
}

/** What one block needs from the rest of the document. */
export type MarkdownBlockReferences = {
  /** Link definitions the block's references resolve against. */
  links: readonly Definition[]
  /** Footnote references made before this block, in first-reference order with their counts. */
  seed: readonly { identifier: string; label: string; count: number }[]
}

const SEED_TAG = 'comment-markdown-footnote-seed'

export function definitionKey(kind: MarkdownDefinition['kind'], identifier: string): string {
  return `${kind}:${identifier}`
}

/** Top-level definitions in `tree`, parsed from `source`, which starts at `offset` in the document. */
export function collectDefinitions(
  tree: Root,
  source: string,
  offset: number
): MarkdownDefinition[] {
  const definitions: MarkdownDefinition[] = []
  for (const node of tree.children) {
    if (node.type !== 'definition' && node.type !== 'footnoteDefinition') {
      continue
    }
    const start = node.position?.start.offset
    const end = node.position?.end.offset
    if (start === undefined || end === undefined) {
      continue
    }
    definitions.push({
      kind: node.type === 'definition' ? 'link' : 'footnote',
      identifier: node.identifier,
      label: node.label ?? node.identifier,
      source: source.slice(start, end),
      start: offset + start,
      ...(node.type === 'definition' ? { node } : {})
    })
  }
  return definitions
}

/** Definitions nested in containers, or footnotes that cite footnotes, are numbered only by the
 *  whole document. */
export function hasUnsharedDefinitions(node: Nodes, topLevel = true): boolean {
  if ((node.type === 'definition' || node.type === 'footnoteDefinition') && !topLevel) {
    return true
  }
  if (node.type === 'footnoteDefinition' && containsFootnoteReference(node)) {
    return true
  }
  return (
    'children' in node &&
    node.children.some((child) => hasUnsharedDefinitions(child, node.type === 'root'))
  )
}

function containsFootnoteReference(node: Nodes): boolean {
  return (
    node.type === 'footnoteReference' ||
    ('children' in node && node.children.some(containsFootnoteReference))
  )
}

/** Source appended to a block's parse so its references resolve; footnote bodies are not needed
 *  there, only their labels. */
export function definitionContext(definitions: readonly MarkdownDefinition[]): string {
  return definitions
    .map((definition) =>
      definition.kind === 'link' ? definition.source : `[^${definition.label}]: .`
    )
    .join('\n\n')
}

/** Footnote references in document order, skipping those inside definitions. */
export function footnoteReferences(tree: Root): FootnoteReference[] {
  const references: FootnoteReference[] = []
  const visit = (node: Nodes): void => {
    if (node.type === 'footnoteDefinition') {
      return
    }
    if (node.type === 'footnoteReference') {
      references.push(node)
      return
    }
    if ('children' in node) {
      node.children.forEach(visit)
    }
  }
  visit(tree)
  return references
}

export function hasLinkReference(node: Nodes): boolean {
  return (
    node.type === 'linkReference' ||
    node.type === 'imageReference' ||
    ('children' in node && node.children.some(hasLinkReference))
  )
}

/** Gives a block the document's numbering: references before it are converted first, in a seed
 *  the rehype step then drops. Footnote definitions render only in the document's footer. */
export function remarkBlockReferences(
  references: MarkdownBlockReferences,
  footer = false
): () => (tree: Root) => void {
  return () => (tree) => {
    if (!footer) {
      tree.children = tree.children.filter((node) => node.type !== 'footnoteDefinition')
    }
    const seed = references.seed.flatMap(({ identifier, label, count }) =>
      Array.from({ length: count }, (): FootnoteReference => ({
        type: 'footnoteReference',
        identifier,
        label
      }))
    )
    if (seed.length > 0) {
      tree.children.unshift({ type: 'paragraph', data: { hName: SEED_TAG }, children: seed })
    }
    tree.children.push(...references.links.map((node) => structuredClone(node)))
  }
}

export function rehypeDropFootnoteSeed(): (tree: HastRoot) => void {
  return (tree) => {
    tree.children = tree.children.filter(
      (node) => !(node.type === 'element' && (node as Element).tagName === SEED_TAG)
    )
  }
}
