import { afterEach, describe, expect, it } from 'vitest'
import { hostWorktreeTarget } from '../../../../../../shared/worktree/host-qualified-identity'
import '../../../../../../shared/workspace-scope'
import {
  claimCombinedDiffView,
  clearCombinedDiffViewMemory,
  readCombinedDiffViewMemory,
  releaseCombinedDiffView,
  rememberCombinedDiffView,
  type CombinedDiffViewLease
} from '@/components/editor/combined-diff/remember-view/combined-diff-view-cache'
import { createTestStore } from '../../../testing/app-store-test-fixture'
import { makeWorktree } from '../worktree.test-fixture'
import { buildWorktreePurgeState } from './worktree-purge-state'
import { applyRemoveWorktreeSuccessState } from './remove-worktree-store-cleanup'

const removed = 'repo::/workspace/deleted'

function mountDiff(worktreeId: string): { key: string; lease: CombinedDiffViewLease } {
  const key = `${worktreeId}::all-diffs::uncommitted::pane`
  const lease = claimCombinedDiffView(key, worktreeId)
  rememberCombinedDiffView(lease, {
    view: {
      entrySignature: 'entries',
      gitStatusSignature: '',
      sections: [
        {
          key: 'source',
          path: 'source.ts',
          status: 'modified',
          originalContent: 'before'.repeat(1000),
          modifiedContent: 'after'.repeat(1000),
          collapsed: false,
          loading: false,
          dirty: false,
          diffResult: null,
          largeDiffRenderLimit: null
        }
      ],
      sectionHeights: {},
      loadedIndices: [0]
    },
    scrollTop: 42,
    scrollAnchor: { key: 'source', offset: 0 }
  })
  return { key, lease }
}

function seedDiff(worktreeId: string): string {
  const { key, lease } = mountDiff(worktreeId)
  releaseCombinedDiffView(lease)
  return key
}

afterEach(() => {
  clearCombinedDiffViewMemory()
})

describe('removed workspace diff memory', () => {
  it('ignores the unmount write of a viewer whose workspace was already removed', () => {
    const { key, lease } = mountDiff(removed)
    const store = createTestStore()
    applyRemoveWorktreeSuccessState(store.setState, removed, new Set())
    releaseCombinedDiffView(lease)
    rememberCombinedDiffView(lease, { scrollTop: 7, scrollAnchor: { key: 'source', offset: 3 } })
    expect(readCombinedDiffViewMemory(key)).toBeUndefined()
    // A workspace recreated under the same id starts fresh once its viewer mounts.
    rememberCombinedDiffView(claimCombinedDiffView(key, removed), { scrollTop: 7 })
    expect(readCombinedDiffViewMemory(key)).toEqual({ worktreeId: removed, scrollTop: 7 })
  })

  it('keeps cached views when a different host still owns the same workspace id', () => {
    const key = seedDiff(removed)
    const store = createTestStore()
    store.setState({
      worktreesByRepo: {
        repo: [
          makeWorktree({ id: removed, repoId: 'repo', hostId: 'local' }),
          makeWorktree({ id: removed, repoId: 'repo', hostId: 'runtime:remote' })
        ]
      }
    })
    buildWorktreePurgeState(store.getState(), [
      hostWorktreeTarget({ id: removed, hostId: 'runtime:remote' })
    ])
    expect(readCombinedDiffViewMemory(key)?.scrollTop).toBe(42)
  })
})
