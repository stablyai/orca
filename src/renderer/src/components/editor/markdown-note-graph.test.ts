import { describe, expect, it } from 'vitest'
import type { MarkdownDocument } from '../../../../shared/filesystem-entry-types'
import type { SearchResult } from '../../../../shared/code-search-types'
import { buildMarkdownNoteGraph } from './markdown-note-graph'
import { layoutMarkdownNoteGraph } from './markdown-note-graph-layout'

function doc(relativePath: string): MarkdownDocument {
  const basename = relativePath.split('/').pop() ?? relativePath
  return {
    filePath: `/repo/${relativePath}`,
    relativePath,
    basename,
    name: basename.replace(/\.md$/, '')
  }
}

function search(hits: Record<string, string[]>): SearchResult {
  const files = Object.entries(hits).map(([relativePath, lines]) => ({
    filePath: `/repo/${relativePath}`,
    relativePath,
    matches: lines.map((lineContent, index) => ({
      line: index + 1,
      column: 1,
      matchLength: 1,
      lineContent
    }))
  }))
  return { files, totalMatches: files.length, truncated: false }
}

const documents = ['a.md', 'b.md', 'c.md', 'lonely.md', 'notes/d.md'].map(doc)

describe('buildMarkdownNoteGraph', () => {
  it('builds one undirected edge per linked pair and leaves out unlinked notes', () => {
    const graph = buildMarkdownNoteGraph(
      documents,
      search({
        'a.md': ['[[b]] and [[b|again]]', '[c](c.md)', '[[a]] self link', '[[missing]]'],
        'b.md': ['back to [[a]]'],
        'notes/d.md': ['[up](../a.md)']
      })
    )
    expect(graph.nodes.map((node) => [node.key, node.degree])).toEqual([
      ['a.md', 3],
      ['b.md', 1],
      ['c.md', 1],
      ['notes/d.md', 1]
    ])
    expect(graph.edges).toHaveLength(3)
    expect(graph.omittedNodes).toBe(0)
  })

  it('keeps the best-connected notes when over the node cap', () => {
    const graph = buildMarkdownNoteGraph(
      documents,
      search({ 'a.md': ['[[b]] [[c]]'], 'notes/d.md': ['[[b]]'] }),
      2
    )
    expect(graph.nodes.map((node) => node.key)).toEqual(['a.md', 'b.md'])
    expect(graph.edges).toEqual([{ source: 'a.md', target: 'b.md' }])
    expect(graph.omittedNodes).toBe(2)
  })

  it('keeps the open note when the node cap would leave it out', () => {
    const graph = buildMarkdownNoteGraph(
      documents,
      search({ 'a.md': ['[[b]] [[c]]'], 'notes/d.md': ['[[b]]'] }),
      2,
      'notes/d.md'
    )
    expect(graph.nodes.map((node) => node.key)).toEqual(['a.md', 'notes/d.md'])
    expect(graph.edges).toEqual([])
    expect(graph.omittedNodes).toBe(2)
  })

  it('matches search hits by relative path when the search root is a different absolute path', () => {
    const canonical = search({ 'a.md': ['[[b]]'] })
    canonical.files = canonical.files.map((file) => ({
      ...file,
      filePath: `/real/repo/${file.relativePath}`
    }))
    const graph = buildMarkdownNoteGraph(documents, canonical)
    expect(graph.edges).toEqual([{ source: 'a.md', target: 'b.md' }])
  })
})

describe('layoutMarkdownNoteGraph', () => {
  it('places linked notes closer than unlinked ones, deterministically', () => {
    const graph = buildMarkdownNoteGraph(
      documents,
      search({ 'a.md': ['[[b]]'], 'c.md': ['[[notes/d]]'] })
    )
    const first = layoutMarkdownNoteGraph(graph)
    const second = layoutMarkdownNoteGraph(graph)
    expect(second).toEqual(first)
    const distance = (p: string, q: string): number => {
      const a = first.get(p)!
      const b = first.get(q)!
      return Math.hypot(a.x - b.x, a.y - b.y)
    }
    expect(distance('a.md', 'b.md')).toBeLessThan(distance('a.md', 'c.md'))
    expect([...first.values()].every((point) => Number.isFinite(point.x + point.y))).toBe(true)
  })
})
