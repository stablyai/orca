import { describe, expect, it, vi } from 'vitest'
import type { Worktree } from '../../../../../../shared/worktree/types'

// Why mock: the question here is only what the merge asks the fence, not what it answers.
const pendingCalls = vi.hoisted(() => [] as unknown[][])
vi.mock('../metadata/worktree-meta-persist', () => ({
  isColorTagPersistencePending: (...args: unknown[]) => {
    pendingCalls.push(args)
    return false
  },
  isDisplayNamePersistencePending: () => false
}))

import { preserveConcurrentColorTag } from './fetched-worktree-color-tag-fence'

// Regression: the fence scopes entries by runtime owner, but the merge queried it with id, host,
// and identity only, so an identity-less row's query matched the sibling owner's entry.
describe('preserveConcurrentColorTag fence query', () => {
  it("passes the row's runtime owner alongside its identity, and the incoming value", () => {
    const row = {
      id: 'a',
      hostId: 'ssh:box',
      runtimeOwnerEnvironmentId: 'env-b',
      colorTag: null
    } as unknown as Worktree
    preserveConcurrentColorTag([row], [row], [row], () => true, 500)
    expect(pendingCalls.at(-1)).toEqual(['a', 'ssh:box', 500, undefined, 'env-b', null])
  })

  // Regression: a desktop-listed row was reported with an unknown owner, so a HUB sibling's fence
  // matched it on id and host alone.
  it('reports a desktop-listed row as a null owner, not an unknown one', () => {
    const row = { id: 'd', hostId: 'ssh:box', colorTag: null } as unknown as Worktree
    preserveConcurrentColorTag([row], [row], [row], () => true, 500)
    expect(pendingCalls.at(-1)).toEqual(['d', 'ssh:box', 500, undefined, null, null])
  })
})
