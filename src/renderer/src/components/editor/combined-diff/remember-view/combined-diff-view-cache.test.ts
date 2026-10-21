import { afterEach, describe, expect, it } from 'vitest'
import {
  claimCombinedDiffView,
  clearCombinedDiffViewMemory,
  forgetCombinedDiffViewsForWorktrees,
  readCombinedDiffViewMemory,
  releaseCombinedDiffView,
  rememberCombinedDiffView,
  type CombinedDiffViewSuccession
} from './combined-diff-view-cache'

const worktreeId = 'repo::/workspace/a'
const contentKey = `${worktreeId}::all-diffs::uncommitted`

function succession(
  scopeId: string,
  openScopes: readonly string[] = [scopeId],
  content = contentKey
): CombinedDiffViewSuccession {
  return { contentKey: content, scopeId, isScopeOpen: (id) => openScopes.includes(id) }
}

function keyFor(scopeId: string, content = contentKey): string {
  return `${content}::${scopeId}`
}

/** Mounts a tab viewer, scrolls it, then unmounts it as a tab close would. */
function viewThenUnmount(scopeId: string, scrollTop: number, content = contentKey): void {
  const lease = claimCombinedDiffView(
    keyFor(scopeId, content),
    worktreeId,
    succession(scopeId, [scopeId], content)
  )
  releaseCombinedDiffView(lease)
  // Why: the viewer's unmount snapshot writes after release, so mirror that order.
  rememberCombinedDiffView(lease, { scrollTop })
}

afterEach(() => {
  clearCombinedDiffViewMemory()
})

describe('combined diff view succession', () => {
  it('moves a closed tab view to the fresh tab that reopens the same diff', () => {
    viewThenUnmount('tab-1', 640)

    const nextKey = keyFor('tab-2')
    expect(
      readCombinedDiffViewMemory(nextKey, { worktreeId, succession: succession('tab-2') })
        ?.scrollTop
    ).toBe(640)

    claimCombinedDiffView(nextKey, worktreeId, succession('tab-2'))

    expect(readCombinedDiffViewMemory(nextKey)?.scrollTop).toBe(640)
    expect(readCombinedDiffViewMemory(keyFor('tab-1'))).toBeUndefined()
  })

  it('keeps a still-open but inactive tab view out of reach of a second tab', () => {
    viewThenUnmount('tab-1', 640)

    const nextKey = keyFor('tab-2')
    const bothOpen = succession('tab-2', ['tab-1', 'tab-2'])
    expect(readCombinedDiffViewMemory(nextKey, { worktreeId, succession: bothOpen })).toBe(
      undefined
    )
    claimCombinedDiffView(nextKey, worktreeId, bothOpen)

    expect(readCombinedDiffViewMemory(nextKey)).toBeUndefined()
    expect(readCombinedDiffViewMemory(keyFor('tab-1'))?.scrollTop).toBe(640)
  })

  it('never takes the view of a viewer that is still mounted', () => {
    const mounted = claimCombinedDiffView(keyFor('tab-1'), worktreeId, succession('tab-1'))
    rememberCombinedDiffView(mounted, { scrollTop: 320 })

    // The mounted tab's scope already reads as closed, so only the lease protects it.
    claimCombinedDiffView(keyFor('tab-2'), worktreeId, succession('tab-2'))

    expect(readCombinedDiffViewMemory(keyFor('tab-2'))).toBeUndefined()
    expect(readCombinedDiffViewMemory(keyFor('tab-1'))?.scrollTop).toBe(320)
  })

  it('inherits the latest closed view and drops older ones for the same diff', () => {
    viewThenUnmount('tab-1', 100)
    viewThenUnmount('tab-2', 200)

    claimCombinedDiffView(keyFor('tab-3'), worktreeId, succession('tab-3'))

    expect(readCombinedDiffViewMemory(keyFor('tab-3'))?.scrollTop).toBe(200)
    expect(readCombinedDiffViewMemory(keyFor('tab-1'))).toBeUndefined()
    expect(readCombinedDiffViewMemory(keyFor('tab-2'))).toBeUndefined()
  })

  it('does not inherit across different diffs or workspaces', () => {
    const stagedKey = `${contentKey}::staged`
    viewThenUnmount('tab-1', 100, stagedKey)

    claimCombinedDiffView(keyFor('tab-2'), worktreeId, succession('tab-2'))
    claimCombinedDiffView(keyFor('tab-3'), 'repo::/workspace/b', succession('tab-3'))

    expect(readCombinedDiffViewMemory(keyFor('tab-2'))).toBeUndefined()
    expect(readCombinedDiffViewMemory(keyFor('tab-3'))).toBeUndefined()
    expect(readCombinedDiffViewMemory(keyFor('tab-1', stagedKey))?.scrollTop).toBe(100)
  })

  it('leaves nothing to inherit once the workspace is forgotten', () => {
    viewThenUnmount('tab-1', 640)
    forgetCombinedDiffViewsForWorktrees([worktreeId])

    claimCombinedDiffView(keyFor('tab-2'), worktreeId, succession('tab-2'))

    expect(readCombinedDiffViewMemory(keyFor('tab-2'))).toBeUndefined()
  })
})
