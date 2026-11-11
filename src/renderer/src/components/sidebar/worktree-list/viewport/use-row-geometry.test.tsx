// @vitest-environment happy-dom
import { cleanup, renderHook } from '@testing-library/react'
import { afterEach, expect, it, vi } from 'vitest'
import type { RenderRow } from '../listing/render-row'
import { buildLineageRowProjection } from '../listing/lineage-row-projection'
import { getReorderUnnestRows } from '../drag/worktree-lineage-drag-drop'
import { useWorktreeRowGeometry } from './use-row-geometry'
import type { WorktreeListVirtualizer } from './use-virtualizer'

vi.mock('@/store', () => ({ useAppStore: vi.fn() }))
afterEach(cleanup)

it('unnests only the picked host copy outside the padded folder surface, even with its header offscreen', () => {
  const child = { id: 'r::/child', hostId: 'ssh:box' as const }
  const twin = { id: 'r::/child', hostId: 'local' as const }
  // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: Geometry reads only the identity, depth and grouping fields supplied here.
  const rows = [
    {
      type: 'folder-workspace',
      key: 'folder',
      depth: 0,
      groupDepth: 0,
      folderWorkspace: { id: 'f', executionHostId: 'ssh:box' },
      projectGroup: {}
    },
    {
      type: 'item',
      rowKey: 'child',
      sectionKey: 'all',
      depth: 1,
      groupDepth: 0,
      worktree: child,
      repo: { id: 'r' }
    }
  ] as unknown as RenderRow[]
  const container = document.createElement('div')
  container.scrollTop = 200
  container.getBoundingClientRect = () => new DOMRect(100, 100, 200, 400)
  const content = document.createElement('div')
  content.setAttribute('data-worktree-sidebar-content', '')
  content.getBoundingClientRect = () => new DOMRect(104, -99, 188, 1000)
  container.append(content)
  // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: Folder retention reads cached endpoints; drag-window methods are unused in this test.
  const virtualization = {
    virtualizer: {
      measurementsCache: [
        { start: 0, end: 64 },
        { start: 64, end: 260 }
      ]
    }
  } as unknown as WorktreeListVirtualizer
  const { result } = renderHook(() =>
    useWorktreeRowGeometry({
      rows,
      projection: buildLineageRowProjection(rows, 'none', false),
      virtualization,
      scrollRef: { current: container }
    })
  )
  const folder = 'ssh:box|folder:f'
  for (const [clientX, expected] of [
    [106, [child]],
    [110, []],
    [295, [child]]
  ] as const) {
    const snapshot = result.current.captureFolderRetention(
      { clientX, clientY: 50, lineClientY: 48 },
      new Set([folder])
    )
    expect(
      getReorderUnnestRows({
        legacyIds: [],
        pickedCopies: [child, twin],
        sourceGroupIdentities: ['ssh:box|r::/child', 'local|r::/child'],
        folderParentOf: (identity) => (identity === 'ssh:box|r::/child' ? folder : undefined),
        keepsFolderParent: (identity) => result.current.keepsFolderParent(identity, snapshot)
      })
    ).toEqual(expected)
  }
})
