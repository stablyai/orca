import { describe, expect, it } from 'vitest'
import type { Repo } from '../../../../../../shared/repository/repo-types'
import type { RenderRow } from '../listing/render-row'
import { getProjectHighlightBands, getProjectHighlightSections } from './project-highlight-bands'

function repo(id: string, sidebarHighlight?: boolean): Repo {
  return {
    id,
    path: `/${id}`,
    displayName: id,
    badgeColor: '#22c55e',
    addedAt: 0,
    ...(sidebarHighlight !== undefined ? { sidebarHighlight } : {})
  }
}

function repoHeader(id: string, sidebarHighlight?: boolean): RenderRow {
  return {
    type: 'header',
    key: `repo:${id}`,
    label: id,
    count: 1,
    icon: { kind: 'project' },
    repo: repo(id, sidebarHighlight)
  }
}

function itemStub(id: string): RenderRow {
  return { type: 'pending-creation', key: id, creationId: id, repo: undefined }
}

function measure(sizes: number[], gap = 6): { start: number; end: number }[] {
  let start = 0
  return sizes.map((size) => {
    const measurement = { start, end: start + size }
    start += size + gap
    return measurement
  })
}

describe('getProjectHighlightSections', () => {
  it('spans a highlighted header through its rows until the next header', () => {
    const rows = [
      repoHeader('a', true),
      itemStub('a1'),
      itemStub('a2'),
      repoHeader('b'),
      itemStub('b1')
    ]
    expect(getProjectHighlightSections(rows, 'repo')).toEqual([
      { key: 'hdr:repo:a', color: '#22c55e', startIndex: 0, endIndex: 2 }
    ])
  })

  it('covers only the header when the project is collapsed', () => {
    const rows = [repoHeader('a', true), repoHeader('b', true), itemStub('b1')]
    expect(getProjectHighlightSections(rows, 'repo')).toEqual([
      { key: 'hdr:repo:a', color: '#22c55e', startIndex: 0, endIndex: 0 },
      { key: 'hdr:repo:b', color: '#22c55e', startIndex: 1, endIndex: 2 }
    ])
  })

  it('ends a section at a host header', () => {
    const rows: RenderRow[] = [
      repoHeader('a', true),
      itemStub('a1'),
      {
        type: 'host-header',
        key: 'host:ssh:x',
        hostId: 'ssh:x',
        kind: 'ssh',
        label: 'x',
        detail: 'SSH',
        health: 'available',
        collapsed: false,
        count: 1
      },
      itemStub('x1')
    ]
    expect(getProjectHighlightSections(rows, 'repo')).toEqual([
      { key: 'hdr:repo:a', color: '#22c55e', startIndex: 0, endIndex: 1 }
    ])
  })

  it('ignores highlight when not grouped by project', () => {
    const rows = [repoHeader('a', true), itemStub('a1')]
    expect(getProjectHighlightSections(rows, 'workspace-status')).toEqual([])
  })
})

describe('getProjectHighlightBands', () => {
  it('positions bands from header to last row, skipping the inter-group spacer', () => {
    const rows = [repoHeader('a', true), itemStub('a1'), repoHeader('b', true), itemStub('b1')]
    const sections = getProjectHighlightSections(rows, 'repo')
    const measurements = measure([28, 50, 32, 50])
    expect(
      getProjectHighlightBands({
        sections,
        rows,
        firstHeaderIndex: 0,
        measurements,
        visibleStartIndex: 0,
        visibleEndIndex: 3
      })
    ).toEqual([
      { key: 'hdr:repo:a', color: '#22c55e', top: 0, height: 84 },
      { key: 'hdr:repo:b', color: '#22c55e', top: 94, height: 84 }
    ])
  })

  it('skips sections outside the visible range', () => {
    const rows = [repoHeader('a', true), itemStub('a1'), repoHeader('b', true), itemStub('b1')]
    const bands = getProjectHighlightBands({
      sections: getProjectHighlightSections(rows, 'repo'),
      rows,
      firstHeaderIndex: 0,
      measurements: measure([28, 50, 32, 50]),
      visibleStartIndex: 3,
      visibleEndIndex: 3
    })
    expect(bands.map((band) => band.key)).toEqual(['hdr:repo:b'])
  })
})
