import { describe, expect, it } from 'vitest'
import type { WorktreeOperationOwnerRecord } from './worktree-operation-route'
import { worktreeOwnerRowsTokenOf } from './worktree-owner-rows-token'

const a: WorktreeOperationOwnerRecord = { id: 'a', repoId: 'r1', hostId: 'ssh:one' }
const b: WorktreeOperationOwnerRecord = { id: 'b', repoId: 'r1' }

describe('worktreeOwnerRowsTokenOf', () => {
  it('keeps the token across non-owner patches and changes it for owner changes', () => {
    const base = worktreeOwnerRowsTokenOf({ r1: [a, b] })
    expect(worktreeOwnerRowsTokenOf({ r1: [{ ...a }, b] })).toBe(base)
    expect(worktreeOwnerRowsTokenOf({ r1: [a, { ...b, hostId: undefined }] })).toBe(base)
    expect(worktreeOwnerRowsTokenOf({ r1: [{ ...a, hostId: 'ssh:two' }, b] })).not.toBe(base)
  })

  it('treats a row reorder as an owner change', () => {
    const base = worktreeOwnerRowsTokenOf({ r1: [a, b] })
    expect(worktreeOwnerRowsTokenOf({ r1: [b, a] })).not.toBe(base)
  })
})
