import { describe, expect, it } from 'vitest'
import { withStoreCrossStoreLineage } from './cross-store-lineage-state'

const RECORD = { childWorkspaceKey: 'worktree:repo::/srv/child', childInstanceId: 'child' }
const OTHER = { childWorkspaceKey: 'worktree:repo::/srv/other', childInstanceId: 'other' }

describe('withStoreCrossStoreLineage', () => {
  it('keeps a Remove Parent made after the list request started', () => {
    const atStart = {
      'env-1': { 'worktree:repo::/srv/child': RECORD, 'worktree:repo::/srv/other': OTHER }
    }
    const afterRemove = { 'env-1': { 'worktree:repo::/srv/other': OTHER } }
    const patch = withStoreCrossStoreLineage(
      { crossStoreLineageByStoreKey: afterRemove, ownLineageInstallationId: 'mac' },
      'env-1',
      {
        worktreeLineageById: {},
        workspaceLineageByChildKey: {},
        crossStoreLineageByChildKey: atStart['env-1']
      },
      { crossStoreLineageByStoreKey: atStart }
    )
    expect(patch).toEqual({})
  })
})
