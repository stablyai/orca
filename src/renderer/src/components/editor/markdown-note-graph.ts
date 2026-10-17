import type { MarkdownDocument } from '../../../../shared/filesystem-entry-types'
import type { SearchOptions, SearchResult } from '../../../../shared/code-search-types'
import { createMarkdownLinkResolver, markdownDocumentKey } from './markdown-link-resolver'

export type MarkdownNoteGraphNode = { key: string; document: MarkdownDocument; degree: number }
export type MarkdownNoteGraphEdge = { source: string; target: string }
export type MarkdownNoteGraph = {
  nodes: MarkdownNoteGraphNode[]
  edges: MarkdownNoteGraphEdge[]
  /** Linked notes left out to keep the layout responsive. */
  omittedNodes: number
}

// Why: the force layout is O(n²) per step; past this the dialog would stall the renderer.
export const MARKDOWN_NOTE_GRAPH_MAX_NODES = 300

/** Every link line contains `[[` or `](`, so one search returns the whole link set. */
export function markdownNoteGraphSearchOptions(rootPath: string): SearchOptions {
  return {
    query: String.raw`\[\[|\]\(`,
    rootPath,
    useRegex: true,
    includePattern: '*.md,*.mdx,*.markdown',
    maxResults: 2000
  }
}

/** Notes connected by at least one resolved link, keeping the best-connected when there are too many. */
export function buildMarkdownNoteGraph(
  documents: MarkdownDocument[],
  search: SearchResult,
  maxNodes = MARKDOWN_NOTE_GRAPH_MAX_NODES,
  activeKey?: string | null
): MarkdownNoteGraph {
  const resolver = createMarkdownLinkResolver(documents)
  const edgeKeys = new Set<string>()
  const edges: MarkdownNoteGraphEdge[] = []
  const nodes = new Map<string, MarkdownNoteGraphNode>()
  const node = (document: MarkdownDocument): MarkdownNoteGraphNode => {
    const key = markdownDocumentKey(document)
    let entry = nodes.get(key)
    if (!entry) {
      entry = { key, document, degree: 0 }
      nodes.set(key, entry)
    }
    return entry
  }
  for (const file of search.files) {
    const source = resolver.documentForFile(file.filePath, file.relativePath)
    if (!source) {
      continue
    }
    for (const match of file.matches) {
      for (const linked of resolver.linkTargets(match.lineContent, source)) {
        const from = node(source)
        const to = node(linked)
        // Why one undirected edge: the graph shows that two notes are connected, not how often.
        const edgeKey = [from.key, to.key].sort().join('\n')
        if (from.key === to.key || edgeKeys.has(edgeKey)) {
          continue
        }
        edgeKeys.add(edgeKey)
        edges.push({ source: from.key, target: to.key })
        from.degree += 1
        to.degree += 1
      }
    }
  }
  const linkedNodes = [...nodes.values()].filter((entry) => entry.degree > 0)
  const kept = linkedNodes
    .sort((a, b) => b.degree - a.degree || a.key.localeCompare(b.key))
    .slice(0, maxNodes)
  // Why: the dialog highlights the open note, so it must survive the cap.
  const active = activeKey ? linkedNodes.find((entry) => entry.key === activeKey) : undefined
  if (active && kept.length > 0 && !kept.includes(active)) {
    kept[kept.length - 1] = active
  }
  const keptKeys = new Set(kept.map((entry) => entry.key))
  return {
    nodes: kept,
    edges: edges.filter((edge) => keptKeys.has(edge.source) && keptKeys.has(edge.target)),
    omittedNodes: linkedNodes.length - kept.length
  }
}
