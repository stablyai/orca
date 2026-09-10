import { describe, expect, it } from 'vitest'
import { buildMaestroCanvasIndex } from './maestro-canvas-index'

describe('Maestro Canvas index', () => {
  it('keeps host and workspace identity separate', () => {
    expect(
      buildMaestroCanvasIndex([
        {
          executionHostId: 'native',
          workspaceKey: 'folder:one',
          revision: 1,
          updatedAt: '2026-08-21T10:00:00Z',
          intentCounts: { pending: 0, claimed: 0, settled: 0 }
        },
        {
          executionHostId: 'ssh:one',
          workspaceKey: 'folder:one',
          revision: 2,
          updatedAt: '2026-08-21T11:00:00Z',
          intentCounts: { pending: 1, claimed: 0, settled: 0 }
        },
        {
          executionHostId: 'native',
          workspaceKey: 'id:repo::/path',
          revision: 9,
          updatedAt: '2026-08-21T12:00:00Z',
          intentCounts: { pending: 0, claimed: 0, settled: 0 }
        }
      ])
    ).toHaveLength(2)
  })
})
