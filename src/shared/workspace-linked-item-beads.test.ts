import { describe, expect, it } from 'vitest'
import type { WorkspaceLinkedItem } from './worktree/types'
import { areWorkspaceLinkedItemsEqual, normalizeWorkspaceLinkedItem } from './workspace-linked-item'
import { WorkspaceLinkedItemSchema } from './workspace-linked-item-schema'

// The exact shape buildBeadsWorkspaceSource emits: number 0, no web URL.
const BEADS_ITEM: WorkspaceLinkedItem = {
  provider: 'beads',
  type: 'issue',
  number: 0,
  title: 'Wire the beads task source',
  url: '',
  beadsIdentifier: 'beads-probe-ay8',
  repoId: 'repo-1'
}

describe('beads workspace linked item', () => {
  it('normalizes a beads item and keeps beadsIdentifier', () => {
    expect(normalizeWorkspaceLinkedItem(BEADS_ITEM)).toEqual(BEADS_ITEM)
  })

  it('allows an empty url only for beads', () => {
    expect(normalizeWorkspaceLinkedItem({ ...BEADS_ITEM, provider: 'jira' })).toBeNull()
    expect(normalizeWorkspaceLinkedItem({ ...BEADS_ITEM, provider: 'github' })).toBeNull()
  })

  it('drops a blank beadsIdentifier instead of storing it', () => {
    const normalized = normalizeWorkspaceLinkedItem({ ...BEADS_ITEM, beadsIdentifier: '  ' })
    expect(normalized).not.toBeNull()
    expect(normalized).not.toHaveProperty('beadsIdentifier')
  })

  it('survives the IPC schema worktree creation applies', () => {
    // Same zod schema main's worktrees IPC parses linkedWorkItem with.
    expect(WorkspaceLinkedItemSchema.parse(BEADS_ITEM)).toEqual(BEADS_ITEM)
    expect(WorkspaceLinkedItemSchema.safeParse({ ...BEADS_ITEM, title: '  ' }).success).toBe(false)
    expect(WorkspaceLinkedItemSchema.safeParse({ ...BEADS_ITEM, number: 'x' }).success).toBe(false)
  })

  it('compares beads items by beadsIdentifier', () => {
    expect(areWorkspaceLinkedItemsEqual(BEADS_ITEM, { ...BEADS_ITEM })).toBe(true)
    expect(
      areWorkspaceLinkedItemsEqual(BEADS_ITEM, { ...BEADS_ITEM, beadsIdentifier: 'beads-x-1' })
    ).toBe(false)
  })
})
