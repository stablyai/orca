import { describe, expect, it } from 'vitest'
import { getWorktreeHostIdentity } from '../../../../../../shared/worktree/host-qualified-identity'
import type { Worktree } from '../../../../../../shared/worktree/types'
import { getHoveredWorkspaceIdentity } from './child-workspaces-toggle-target'
import { worktree as baseWorktree } from '../../worktree-list/grouping/worktree-list-groups-test-fixtures'

type HoverDocument = NonNullable<Parameters<typeof getHoveredWorkspaceIdentity>[0]>

function worktree(id: string, overrides: Partial<Worktree> = {}): Worktree {
  return { ...baseWorktree, id, instanceId: `${id}-instance`, path: `/tmp/${id}`, ...overrides }
}

function hoveredDocument(...hovered: Worktree[]): HoverDocument {
  const rows = hovered.map((row) => ({
    dataset: { worktreeId: row.id, worktreeHostIdentity: getWorktreeHostIdentity(row) }
  }))
  // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: the resolver reads only length, item() and dataset from the hovered-row query.
  return {
    activeElement: null,
    querySelectorAll: () => ({ length: rows.length, item: (index: number) => rows[index] ?? null })
  } as unknown as HoverDocument
}

const parent = worktree('parent')
const child = worktree('child')

describe('getHoveredWorkspaceIdentity', () => {
  it('uses the deepest hovered worktree row', () => {
    expect(getHoveredWorkspaceIdentity(hoveredDocument(parent, child))).toEqual({
      workspaceId: child.id,
      hostIdentity: getWorktreeHostIdentity(child)
    })
  })
})
