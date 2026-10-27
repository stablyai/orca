import { describe, expect, it } from 'vitest'
import type { Repo } from '../../../../shared/repo-types'
import { reconcileFetchedRepos, reuseEqualRecordMap } from './repo-identity-reconcile'

function makeRepo(id: string, overrides: Partial<Repo> = {}): Repo {
  return { id, path: `/${id}`, displayName: id, badgeColor: '#000', addedAt: 1, ...overrides }
}

describe('reconcileFetchedRepos', () => {
  it('reconciles repos whose nested records were rebuilt by hydration and IPC', () => {
    // IPC clones nested records and main rebuilds hookSettings; reference comparison alone falsely changes all repos.
    const nested = (): Partial<Repo> => ({
      hookSettings: { mode: 'auto', scripts: { setup: 'echo hi', archive: '' } },
      gitRemoteIdentity: {
        canonicalKey: 'github.com/o/n',
        remoteName: 'origin',
        remoteUrl: 'git@github.com:o/n.git'
      },
      importedExternalWorktreePaths: ['/a', '/b']
    })
    const previous = [makeRepo('a', nested())]
    const next = structuredClone([makeRepo('a', nested())]) as Repo[]

    expect(reconcileFetchedRepos(previous, next)).toBe(previous)
  })

  it('keeps fetched data when optional repo keys differ with the same key count', () => {
    const previous = [makeRepo('a', { projectGroupId: undefined })]
    const next = [makeRepo('a', { projectGroupOrder: 2 })]
    const result = reconcileFetchedRepos(previous, next)
    expect(result[0]).toBe(next[0])
  })

  it('preserves same-id repo identity only within the matching host', () => {
    const previous = [
      makeRepo('same', { executionHostId: 'local', displayName: 'Local' }),
      makeRepo('same', { executionHostId: 'runtime:env-1', displayName: 'Remote' })
    ]
    const next = [
      makeRepo('same', { executionHostId: 'runtime:env-1', displayName: 'Remote' }),
      makeRepo('same', { executionHostId: 'local', displayName: 'Local' })
    ]

    const result = reconcileFetchedRepos(previous, next)

    expect(result[0]).toBe(previous[1])
    expect(result[1]).toBe(previous[0])
  })
})

describe('reuseEqualRecordMap', () => {
  const row = (value: string): { value: string; nested: { tags: string[] } } => ({
    value,
    nested: { tags: [value, 'shared'] }
  })

  it('reuses the previous entry for structurally equal nested values', () => {
    const previous = { a: row('a'), b: row('b') }
    const result = reuseEqualRecordMap(previous, { a: row('a'), b: row('changed') })
    expect(result).not.toBe(previous)
    expect(result.a).toBe(previous.a)
    expect(result.b).toEqual(row('changed'))
  })

  it('returns a new map when a key is swapped for a same-count replacement', () => {
    // Same counts can hide replaced keys; next-key misses detect removals without another previous-key pass.
    const previous = { a: row('a'), b: row('b') }
    const result = reuseEqualRecordMap(previous, { a: row('a'), c: row('b') })
    expect(result).not.toBe(previous)
    expect(Object.keys(result)).toEqual(['a', 'c'])
  })
})
