import { describe, expect, expectTypeOf, it } from 'vitest'
import {
  findIndexedProjectGroupOwner,
  resolveIndexedProjectGroupOwner
} from './worktree-runtime-owner-index'

describe('worktree runtime owner index', () => {
  it('preserves full project-group records while resolving host-qualified ids', () => {
    const local = { id: 'group-1', name: 'Local group', executionHostId: 'local' }
    const remote = { id: 'group-1', name: 'Remote group', executionHostId: 'ssh:target' }
    const groups = [local, remote]

    expect(resolveIndexedProjectGroupOwner(groups, 'group-1').kind).toBe('ambiguous')
    expect(findIndexedProjectGroupOwner(groups, 'group-1')).toBeNull()
    const owner = findIndexedProjectGroupOwner(groups, 'group-1', 'ssh:target')
    expect(owner).toBe(remote)
    expectTypeOf(owner).toEqualTypeOf<typeof remote | null>()
  })
})
