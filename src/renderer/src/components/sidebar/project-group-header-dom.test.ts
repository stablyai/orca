import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'

function readWorktreeListSource(): string {
  return readFileSync(
    fileURLToPath(new URL('./worktree-list/rows/SectionHeader.tsx', import.meta.url)),
    'utf8'
  )
}

function readHeaderDragSource(): string {
  return readFileSync(
    fileURLToPath(new URL('./worktree-list/drag/use-header-drag.ts', import.meta.url)),
    'utf8'
  )
}

describe('Project Group header drag DOM source', () => {
  it('renders concrete Project Group header drag attributes separately from repo headers', () => {
    const source = readWorktreeListSource()

    expect(source).toContain('data-project-group-header-id={projectGroupIdForHeader}')
    expect(source).toContain('data-project-group-header-index={projectGroupHeaderIndex}')
    expect(source).toContain('data-project-group-header-bucket={projectGroupHeaderBucketKey}')
    expect(source).toContain('data-project-group-header-drag-handle=')
  })

  it('commits Project Group manual sorting through updateProjectGroup tabOrder', () => {
    const source = readHeaderDragSource()

    expect(source).toContain('const updateProjectGroup = useAppStore((s) => s.updateProjectGroup)')
    // Why: the commit must carry the group's owner host so a non-focused host still persists the order.
    expect(source).toContain(
      'void updateProjectGroup(groupId, { tabOrder }, { hostId: ownerHostId ?? undefined })'
    )
  })

  it('keeps grab cursor on the title surface and dual handle attrs on row + surface', () => {
    // Why: lock the cursor/hit-test split so a cleanup does not put grab back on the whole row
    // or drop row-level handle attrs that arm drag from indent/padding.
    const source = readWorktreeListSource()
    const headerBlockStart = source.indexOf('data-repo-header-id={projectIdForHeader}')
    const headerBlockEnd = source.indexOf('<ProjectHeaderActions>', headerBlockStart)
    expect(headerBlockStart).toBeGreaterThan(-1)
    expect(headerBlockEnd).toBeGreaterThan(headerBlockStart)
    const headerBlock = source.slice(headerBlockStart, headerBlockEnd)

    // Dual handle placement: row (indent/padding) + title surface.
    expect(headerBlock.match(/data-repo-header-drag-handle=/g)?.length).toBe(2)
    expect(headerBlock.match(/data-project-group-header-drag-handle=/g)?.length).toBe(2)
    // Surface owns grab; outer row only gets cursor-pointer when not draggable.
    expect(headerBlock).toContain(
      "!(isDraggableRepoHeader || isDraggableProjectGroupHeader) && 'cursor-pointer'"
    )
    expect(headerBlock).toContain("'flex min-w-0 flex-1 items-center gap-1.5 self-stretch'")
    expect(headerBlock).toContain("'cursor-grab active:cursor-grabbing'")
    // Row-level ternary grab must stay gone.
    expect(headerBlock).not.toMatch(
      /isDraggableRepoHeader \|\| isDraggableProjectGroupHeader\s*\?\s*'cursor-grab/
    )
  })
})
