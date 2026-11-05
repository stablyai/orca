// @vitest-environment happy-dom

import { renderHook } from '@testing-library/react'
import { describe, expect, it } from 'vitest'
import { useWorkspaceCleanupRowOrder } from './use-workspace-cleanup-row-order'
import type { WorkspaceCleanupSortState } from '../../../../shared/workspace-cleanup/workspace-cleanup-filter-model'

type Row = { worktreeId: string }

const row = (worktreeId: string): Row => ({ worktreeId })
const ids = (rows: readonly Row[]): string[] => rows.map((entry) => entry.worktreeId)
const ascending: WorkspaceCleanupSortState = { field: 'name', direction: 'asc' }

describe('workspace cleanup streaming row order', () => {
  it('commits appended positions after each rendered stream tick', () => {
    const view = renderHook(
      ({ rows, streaming }: { rows: readonly Row[]; streaming: boolean }) =>
        useWorkspaceCleanupRowOrder({ rows, streaming, sort: ascending }),
      { initialProps: { rows: [row('a'), row('b')], streaming: false } }
    )

    view.rerender({ rows: [row('a'), row('d'), row('b'), row('c')], streaming: true })
    expect(ids(view.result.current)).toEqual(['a', 'b', 'd', 'c'])

    view.rerender({ rows: [row('c'), row('d'), row('b'), row('a')], streaming: true })
    expect(ids(view.result.current)).toEqual(['a', 'b', 'd', 'c'])
  })
})
