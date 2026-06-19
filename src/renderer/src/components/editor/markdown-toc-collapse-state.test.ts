import { describe, expect, it } from 'vitest'
import type { MarkdownTocItem } from './markdown-table-of-contents'
import {
  collapseMarkdownTocToLevel,
  collectMarkdownTocParentIds,
  isMarkdownTocItemExpanded,
  pruneMarkdownTocCollapsedIds,
  toggleMarkdownTocCollapsedId
} from './markdown-toc-collapse-state'

const sampleToc: MarkdownTocItem[] = [
  {
    id: 'intro',
    level: 1,
    title: 'Intro',
    children: [
      {
        id: 'setup',
        level: 2,
        title: 'Setup',
        children: [
          {
            id: 'install',
            level: 3,
            title: 'Install',
            children: []
          }
        ]
      },
      {
        id: 'usage',
        level: 2,
        title: 'Usage',
        children: []
      }
    ]
  }
]

describe('markdown toc collapse state', () => {
  it('collects parent ids for nested headings', () => {
    expect([...collectMarkdownTocParentIds(sampleToc)].sort()).toEqual(['intro', 'setup'])
  })

  it('collapses parents at and below the selected level', () => {
    expect([...collapseMarkdownTocToLevel(sampleToc, 1)].sort()).toEqual(['intro', 'setup'])
    expect([...collapseMarkdownTocToLevel(sampleToc, 2)].sort()).toEqual(['setup'])
    expect([...collapseMarkdownTocToLevel(sampleToc, 3)]).toEqual([])
  })

  it('toggles and prunes stale collapsed ids', () => {
    const toggled = toggleMarkdownTocCollapsedId(new Set(['setup']), 'setup')
    expect([...toggled]).toEqual([])

    const pruned = pruneMarkdownTocCollapsedIds(new Set(['setup', 'missing']), sampleToc)
    expect([...pruned]).toEqual(['setup'])
  })

  it('reports expanded state from collapsed ids', () => {
    const collapsed = new Set(['intro'])
    expect(isMarkdownTocItemExpanded(collapsed, sampleToc[0])).toBe(false)
    expect(isMarkdownTocItemExpanded(collapsed, sampleToc[0].children[1])).toBe(true)
  })
})
