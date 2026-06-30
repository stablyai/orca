import { describe, expect, it } from 'vitest'
import type { ArchitectureViewDto } from '../../../../shared/scryer/architecture-view'
import { architectureViewToDiagramModel } from './architecture-view-model'

describe('architecture view model adapter', () => {
  it('projects ArchitectureViewDto links into the renderer diagram model without flow state', () => {
    const view: ArchitectureViewDto = {
      version: '0.3',
      layer: 'plan',
      nodes: [
        { id: 'api', kind: 'system', name: 'API', appearance: { shape: 'hexagon' } },
        { id: 'web', kind: 'container', name: 'Web', parentId: 'api', technology: 'React' },
        {
          id: 'task',
          kind: 'symbol',
          name: 'Task',
          parentId: 'web',
          appearance: { symbolKind: 'model' }
        }
      ],
      links: [{ id: 'link-web-api', src: 'web', dst: 'api', label: 'calls' }],
      groups: [{ id: 'frontend', name: 'Frontend', memberIds: ['web'] }],
      sourceMap: { web: [{ pattern: 'src/web.ts' }] },
      boundaries: { web: [{ pattern: 'src/web/**', comment: 'owned source boundary' }] },
      treeRows: [
        { id: 'api', kind: 'system', name: 'API', depth: 0, path: 'API', childCount: 1 },
        {
          id: 'web',
          kind: 'container',
          name: 'Web',
          parentId: 'api',
          depth: 1,
          path: 'API / Web',
          childCount: 0
        }
      ],
      sourceMapRows: [{ ownerId: 'web', locations: [{ pattern: 'src/web.ts' }] }],
      boundaryRows: [
        { nodeId: 'web', sources: [{ pattern: 'src/web/**', comment: 'owned source boundary' }] }
      ],
      driftIndicators: [],
      diagnostics: [
        {
          severity: 'warning',
          code: 'invalid_hierarchy',
          message: 'Node web has an invalid parent',
          path: 'node:web.parentId'
        }
      ],
      recommendedNextReads: [],
      summary: { nodeCount: 2, linkCount: 1, groupCount: 1 },
      refresh: { strategy: 'overview' }
    }

    const model = architectureViewToDiagramModel(view, '/repo')

    expect(model).toMatchObject({
      projectPath: '/repo',
      nodes: [
        expect.objectContaining({
          id: 'api',
          data: expect.objectContaining({ kind: 'system', shape: 'hexagon' })
        }),
        expect.objectContaining({
          id: 'web',
          parentId: 'api',
          data: expect.objectContaining({ kind: 'container', technology: 'React' })
        }),
        expect.objectContaining({
          id: 'task',
          parentId: 'web',
          data: expect.objectContaining({ kind: 'model' })
        })
      ],
      links: [{ id: 'link-web-api', source: 'web', target: 'api', data: { label: 'calls' } }],
      groups: [{ id: 'frontend', name: 'Frontend', memberIds: ['web'] }],
      sourceMap: { web: [{ pattern: 'src/web.ts' }] },
      boundaries: { web: [{ pattern: 'src/web/**', comment: 'owned source boundary' }] }
    })
    expect(model.validationWarnings).toEqual([
      {
        kind: 'missing-mention',
        path: 'node:web.parentId',
        reference: 'invalid_hierarchy',
        message: 'Node web has an invalid parent'
      }
    ])
    expect(model).not.toHaveProperty('edges')
    expect(model).not.toHaveProperty('flows')
  })
})
