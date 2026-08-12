import { describe, expect, it } from 'vitest'
import fs from 'node:fs'
import type { Repo } from '../../../../shared/types'
import { reconcileFetchedRepos } from './repo-identity-reconcile'

function makeRepo(id: string, overrides: Partial<Repo> = {}): Repo {
  return { id, path: `/${id}`, displayName: id, badgeColor: '#000', addedAt: 1, ...overrides }
}

describe('reconcileFetchedRepos', () => {
  it('returns the previous array when the fetched list is field-identical', () => {
    const previous = [makeRepo('a'), makeRepo('b')]
    const next = [makeRepo('a'), makeRepo('b')]
    expect(reconcileFetchedRepos(previous, next)).toBe(previous)
  })

  it('reconciles repos whose nested records were rebuilt by hydration and IPC', () => {
    // Why: main's hydrateRepo reconstructs hookSettings on every list and structured-clone
    // rebuilds the rest, so a reference compare would report every real repo as changed.
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

  it('treats a changed nested field as a real change', () => {
    const previous = [makeRepo('a', { importedExternalWorktreePaths: ['/a'] })]
    const next = [makeRepo('a', { importedExternalWorktreePaths: ['/b'] })]
    const result = reconcileFetchedRepos(previous, next)

    expect(result).not.toBe(previous)
    expect(result[0].importedExternalWorktreePaths).toEqual(['/b'])
  })

  it('treats a nested field gaining a key as a real change', () => {
    const previous = [
      makeRepo('a', { hookSettings: { mode: 'auto', scripts: { setup: '', archive: '' } } })
    ]
    const next = [
      makeRepo('a', {
        hookSettings: {
          mode: 'auto',
          setupRunPolicy: 'run-by-default',
          scripts: { setup: '', archive: '' }
        }
      })
    ]

    expect(reconcileFetchedRepos(previous, next)).not.toBe(previous)
  })

  it('reuses unchanged repo objects while reflecting a reorder', () => {
    const previous = [makeRepo('a'), makeRepo('b')]
    const next = [makeRepo('b'), makeRepo('a')]
    const result = reconcileFetchedRepos(previous, next)
    expect(result).not.toBe(previous)
    expect(result.map((r) => r.id)).toEqual(['b', 'a'])
    // Identity preserved so memos keyed on repo objects don't churn.
    expect(result[0]).toBe(previous[1])
    expect(result[1]).toBe(previous[0])
  })

  it('keeps a new object only for the repo whose fields changed', () => {
    const previous = [makeRepo('a'), makeRepo('b')]
    const next = [makeRepo('a'), makeRepo('b', { displayName: 'renamed' })]
    const result = reconcileFetchedRepos(previous, next)
    expect(result[0]).toBe(previous[0])
    expect(result[1]).toBe(next[1])
  })

  it('keeps fetched data when optional repo keys differ with the same key count', () => {
    const previous = [makeRepo('a', { projectGroupId: undefined })]
    const next = [makeRepo('a', { projectGroupOrder: 2 })]
    const result = reconcileFetchedRepos(previous, next)
    expect(result[0]).toBe(next[0])
  })

  it('returns a rebuilt array when repos are added or removed', () => {
    const previous = [makeRepo('a')]
    const next = [makeRepo('a'), makeRepo('b')]
    const result = reconcileFetchedRepos(previous, next)
    expect(result).not.toBe(previous)
    expect(result[0]).toBe(previous[0])
    expect(result.map((r) => r.id)).toEqual(['a', 'b'])
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

  it('uses map-style host identity lookups for large duplicate refreshes', () => {
    const previous = Array.from({ length: 1000 }, (_, index) =>
      makeRepo(`repo-${index}`, { executionHostId: index % 2 === 0 ? 'local' : 'runtime:env-1' })
    )
    const next = previous.map((repo) => ({ ...repo }))

    const result = reconcileFetchedRepos(previous, next)

    expect(result).toBe(previous)
    expect(result.every((repo, index) => repo === previous[index])).toBe(true)
    const source = fs.readFileSync(new URL('./repo-identity-reconcile.ts', import.meta.url), 'utf8')
    expect(source).not.toMatch(/previous\.find|next\.find|findIndex/)
  })
})
