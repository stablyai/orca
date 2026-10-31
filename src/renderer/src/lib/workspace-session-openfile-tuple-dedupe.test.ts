import { describe, expect, it } from 'vitest'
import { foldOpenFilesByOwnerTuple } from './workspace-session-openfile-tuple-dedupe'
import type { OpenFile } from '../store/slices/editor'

function row(
  id: string,
  filePath: string,
  overrides: Partial<Pick<OpenFile, 'worktreeId' | 'runtimeEnvironmentId'>> = {}
): OpenFile {
  return {
    id,
    filePath,
    relativePath: filePath,
    worktreeId: 'wt-1',
    language: 'typescript',
    runtimeEnvironmentId: undefined,
    mode: 'edit',
    isDirty: false,
    ...overrides
  }
}

describe('foldOpenFilesByOwnerTuple', () => {
  it('keeps only the first row per (path, worktree, runtime owner) tuple', () => {
    // The mirror re-appends the raw-path row next to the owned-id row hydration created,
    // so the duplicates can carry different ids — the tuple is what identifies them.
    const folded = foldOpenFilesByOwnerTuple([
      row('editor:wt-1:env-a:%2Ftmp%2Fa.ts', '/tmp/a.ts', { runtimeEnvironmentId: 'env-a' }),
      row('/tmp/a.ts', '/tmp/a.ts', { runtimeEnvironmentId: 'env-a' }),
      row('editor:wt-1:env-a:%2Ftmp%2Fa.ts', '/tmp/a.ts', { runtimeEnvironmentId: 'env-a' })
    ])

    expect(folded.files.map((file) => file.id)).toEqual(['editor:wt-1:env-a:%2Ftmp%2Fa.ts'])
  })

  it('keeps rows owned by a different runtime environment', () => {
    const folded = foldOpenFilesByOwnerTuple([
      row('editor:wt-1:env-a:%2Ftmp%2Fa.ts', '/tmp/a.ts', { runtimeEnvironmentId: 'env-a' }),
      row('editor:wt-1:env-b:%2Ftmp%2Fa.ts', '/tmp/a.ts', { runtimeEnvironmentId: 'env-b' })
    ])

    expect(folded.files.map((file) => file.runtimeEnvironmentId)).toEqual(['env-a', 'env-b'])
  })

  it('keeps rows that differ by worktree or path', () => {
    const folded = foldOpenFilesByOwnerTuple([
      row('/tmp/a.ts', '/tmp/a.ts', { worktreeId: 'wt-1' }),
      row('/tmp/a.ts', '/tmp/a.ts', { worktreeId: 'wt-2' }),
      row('/tmp/b.ts', '/tmp/b.ts', { worktreeId: 'wt-1' })
    ])

    expect(folded.files).toHaveLength(3)
  })

  // Why: hydration resolves the owner with runtimeOwnerKey, which maps any empty environment
  // to the local owner — persisting undefined, '' and null as one tuple mirrors that fold.
  it('treats rows whose environment differs only by emptiness as the same owner', () => {
    const folded = foldOpenFilesByOwnerTuple([
      row('/tmp/a.ts', '/tmp/a.ts'),
      row('/tmp/a.ts', '/tmp/a.ts', { runtimeEnvironmentId: '' }),
      row('/tmp/a.ts', '/tmp/a.ts', { runtimeEnvironmentId: null })
    ])

    expect(folded.files).toHaveLength(1)
  })

  // Why: the removed rows keep distinct ids, so callers need the removed→retained mapping to
  // re-point worktree state (the active-file pointer) at the row that survived the fold. It is
  // scoped per worktree because raw-path ids are absolute path strings another worktree can
  // carry as a live row — worktree wt-2's fold of '/tmp/a.ts' must not blur into wt-1's.
  it('maps every removed row to the retained row it duplicated, scoped to its worktree', () => {
    const folded = foldOpenFilesByOwnerTuple([
      row('editor:wt-1:env-a:%2Ftmp%2Fa.ts', '/tmp/a.ts', { runtimeEnvironmentId: 'env-a' }),
      row('/tmp/a.ts', '/tmp/a.ts', { runtimeEnvironmentId: 'env-a' }),
      row('editor:wt-1:env-a:%2Ftmp%2Fa.ts#2', '/tmp/a.ts', { runtimeEnvironmentId: 'env-a' }),
      row('editor:wt-2:env-a:%2Ftmp%2Fa.ts', '/tmp/a.ts', {
        worktreeId: 'wt-2',
        runtimeEnvironmentId: 'env-a'
      }),
      row('/tmp/a.ts', '/tmp/a.ts', { worktreeId: 'wt-2', runtimeEnvironmentId: 'env-a' })
    ])

    expect(folded.files.map((file) => file.id)).toEqual([
      'editor:wt-1:env-a:%2Ftmp%2Fa.ts',
      'editor:wt-2:env-a:%2Ftmp%2Fa.ts'
    ])
    expect(Object.fromEntries(folded.retainedIdByRemovedId.get('wt-1') ?? [])).toEqual({
      '/tmp/a.ts': 'editor:wt-1:env-a:%2Ftmp%2Fa.ts',
      'editor:wt-1:env-a:%2Ftmp%2Fa.ts#2': 'editor:wt-1:env-a:%2Ftmp%2Fa.ts'
    })
    expect(Object.fromEntries(folded.retainedIdByRemovedId.get('wt-2') ?? [])).toEqual({
      '/tmp/a.ts': 'editor:wt-2:env-a:%2Ftmp%2Fa.ts'
    })
  })
})
