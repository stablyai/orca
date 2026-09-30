import { describe, expect, it } from 'vitest'
import { dedupeOpenFilesByOwnerTuple } from './workspace-session-openfile-tuple-dedupe'
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

describe('dedupeOpenFilesByOwnerTuple', () => {
  it('keeps only the first row per (path, worktree, runtime owner) tuple', () => {
    // The mirror re-appends the raw-path row next to the owned-id row hydration created,
    // so the duplicates can carry different ids — the tuple is what identifies them.
    const folded = dedupeOpenFilesByOwnerTuple([
      row('editor:wt-1:env-a:%2Ftmp%2Fa.ts', '/tmp/a.ts', { runtimeEnvironmentId: 'env-a' }),
      row('/tmp/a.ts', '/tmp/a.ts', { runtimeEnvironmentId: 'env-a' }),
      row('editor:wt-1:env-a:%2Ftmp%2Fa.ts', '/tmp/a.ts', { runtimeEnvironmentId: 'env-a' })
    ])

    expect(folded.map((file) => file.id)).toEqual(['editor:wt-1:env-a:%2Ftmp%2Fa.ts'])
  })

  it('keeps rows owned by a different runtime environment', () => {
    const folded = dedupeOpenFilesByOwnerTuple([
      row('editor:wt-1:env-a:%2Ftmp%2Fa.ts', '/tmp/a.ts', { runtimeEnvironmentId: 'env-a' }),
      row('editor:wt-1:env-b:%2Ftmp%2Fa.ts', '/tmp/a.ts', { runtimeEnvironmentId: 'env-b' })
    ])

    expect(folded.map((file) => file.runtimeEnvironmentId)).toEqual(['env-a', 'env-b'])
  })

  it('keeps rows that differ by worktree or path', () => {
    const folded = dedupeOpenFilesByOwnerTuple([
      row('/tmp/a.ts', '/tmp/a.ts', { worktreeId: 'wt-1' }),
      row('/tmp/a.ts', '/tmp/a.ts', { worktreeId: 'wt-2' }),
      row('/tmp/b.ts', '/tmp/b.ts', { worktreeId: 'wt-1' })
    ])

    expect(folded).toHaveLength(3)
  })

  // Why: hydration resolves the owner with runtimeOwnerKey, which maps any empty environment
  // to the local owner — persisting undefined, '' and null as one tuple mirrors that fold.
  it('treats rows whose environment differs only by emptiness as the same owner', () => {
    const folded = dedupeOpenFilesByOwnerTuple([
      row('/tmp/a.ts', '/tmp/a.ts'),
      row('/tmp/a.ts', '/tmp/a.ts', { runtimeEnvironmentId: '' }),
      row('/tmp/a.ts', '/tmp/a.ts', { runtimeEnvironmentId: null })
    ])

    expect(folded).toHaveLength(1)
  })
})
