import { describe, expect, it } from 'vitest'
import { getWorktreeHostIdentity } from '../../../../shared/worktree/host-qualified-identity'
import type { WorktreeLineage } from '../../../../shared/worktree/lineage-types'
import type { Worktree } from '../../../../shared/worktree/types'
import { folderWorkspaceKey } from '../../../../shared/workspace-scope'
import { resolveChildWorkspacesToggleGroupKey } from './child-workspaces-toggle-target'
import { worktree as baseWorktree } from './worktree-list-groups-test-fixtures'

type ToggleState = Parameters<typeof resolveChildWorkspacesToggleGroupKey>[0]
type HoverDocument = NonNullable<Parameters<typeof resolveChildWorkspacesToggleGroupKey>[2]>

function worktree(id: string, overrides: Partial<Worktree> = {}): Worktree {
  return { ...baseWorktree, id, instanceId: `${id}-instance`, path: `/tmp/${id}`, ...overrides }
}

function lineage(child: Worktree, parent: Worktree): WorktreeLineage {
  return {
    worktreeId: child.id,
    worktreeInstanceId: child.instanceId ?? '',
    parentWorktreeId: parent.id,
    parentWorktreeInstanceId: parent.instanceId ?? '',
    origin: 'cli',
    capture: { source: 'explicit-cli-flag', confidence: 'explicit' },
    createdAt: 1
  }
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

function toggleState(args: {
  worktrees: Worktree[]
  lineageById?: Record<string, WorktreeLineage>
  active?: Worktree
}): ToggleState {
  return {
    activeWorktreeId: args.active?.id ?? null,
    activeWorkspaceExecutionHostId: args.active?.hostId ?? null,
    worktreeLineageById: args.lineageById ?? {},
    worktreesByRepo: { [baseWorktree.repoId]: args.worktrees }
  }
}

const parent = worktree('parent')
const child = worktree('child')
const grandchild = worktree('grandchild')
const loner = worktree('loner')
const family = {
  worktrees: [parent, child, grandchild, loner],
  lineageById: { child: lineage(child, parent), grandchild: lineage(grandchild, child) }
}

describe('resolveChildWorkspacesToggleGroupKey', () => {
  const bothChips = new Set(['lineage:parent', 'lineage:child'])
  const resolve = (
    state: ToggleState,
    doc: HoverDocument,
    chips: ReadonlySet<string> = bothChips
  ): string | null => resolveChildWorkspacesToggleGroupKey(state, chips, doc)

  it('toggles the hovered parent’s own children', () => {
    expect(resolve(toggleState(family), hoveredDocument(parent))).toBe('lineage:parent')
  })

  it('prefers the deepest hovered card, which may itself be a parent', () => {
    expect(resolve(toggleState(family), hoveredDocument(parent, child))).toBe('lineage:child')
  })

  it('folds the parent when the target is a leaf child', () => {
    expect(resolve(toggleState(family), hoveredDocument(grandchild))).toBe('lineage:child')
  })

  it('folds the parent when the target’s own children render no chip', () => {
    expect(resolve(toggleState(family), hoveredDocument(child), new Set(['lineage:parent']))).toBe(
      'lineage:parent'
    )
  })

  it('does nothing when the sidebar renders no chip for the target or its parent', () => {
    // e.g. every child is hidden by a sidebar filter, so the chip is gone
    expect(resolve(toggleState(family), hoveredDocument(parent), new Set())).toBeNull()
    expect(resolve(toggleState(family), hoveredDocument(child), new Set())).toBeNull()
  })

  it('falls back to the active workspace when no card is hovered', () => {
    expect(resolve(toggleState({ ...family, active: parent }), hoveredDocument())).toBe(
      'lineage:parent'
    )
  })

  it('lets the hovered card win over the active one, even when it is in no lineage', () => {
    expect(resolve(toggleState({ ...family, active: parent }), hoveredDocument(loner))).toBeNull()
  })

  it('returns null without a hovered or active workspace', () => {
    expect(resolve(toggleState(family), hoveredDocument())).toBeNull()
  })

  it('lets an active or hovered folder card pass through even with an active parent', () => {
    const folder = worktree(folderWorkspaceKey('folder-1'), { hostId: 'local' })
    expect(resolve(toggleState({ ...family, active: parent }), hoveredDocument(folder))).toBeNull()
    expect(resolve(toggleState({ ...family, active: folder }), hoveredDocument())).toBeNull()
  })

  it('does not fall back to the active parent for a stale hovered card', () => {
    expect(
      resolve(toggleState({ ...family, active: parent }), hoveredDocument(worktree('removed')))
    ).toBeNull()
  })

  it('does not fold an archived parent', () => {
    const archivedParent = { ...parent, isArchived: true }
    expect(
      resolve(
        toggleState({
          worktrees: [archivedParent, child],
          lineageById: { child: lineage(child, archivedParent) }
        }),
        hoveredDocument(child),
        new Set(['lineage:parent'])
      )
    ).toBeNull()
  })

  it('ignores a stale lineage record from an earlier instance', () => {
    const recreatedGrandchild = { ...grandchild, instanceId: 'grandchild-recreated' }
    expect(
      resolve(
        toggleState({ ...family, worktrees: [parent, child, recreatedGrandchild, loner] }),
        hoveredDocument(recreatedGrandchild)
      )
    ).toBeNull()
  })

  it('uses host-qualified keys and ignores same-id rows on another host', () => {
    const remoteParent = worktree('parent', { hostId: 'ssh:box' })
    const remoteChild = worktree('child', { hostId: 'ssh:box' })
    const remoteKey = `lineage:${getWorktreeHostIdentity(remoteParent)}`
    const state = toggleState({
      worktrees: [parent, remoteParent, remoteChild],
      lineageById: { child: lineage(remoteChild, remoteParent) },
      active: remoteChild
    })

    expect(resolve(state, hoveredDocument(), new Set([remoteKey]))).toBe(remoteKey)
    // Why: the local row sharing the parent's id has no chip of its own to fold.
    expect(resolve(state, hoveredDocument(), new Set(['lineage:parent']))).toBeNull()
    expect(resolve(state, hoveredDocument(remoteParent), new Set([remoteKey]))).toBe(remoteKey)
  })
})
