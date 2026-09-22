import { describe, expect, it } from 'vitest'
import {
  readRetiredNameRegistryForRepo,
  retiredNamesAfterRefresh,
  selectRetiredNameRegistry
} from './retired-name-cache'
import { EMPTY_RETIRED_NAME_REGISTRY } from './retired-name-registry'

const loadOf = (repoId: string, names: readonly string[], exhaustedTiers = 0) => ({
  repoId,
  registry: { exhaustedTiers, names }
})

describe('readRetiredNameRegistryForRepo', () => {
  it('reads the requested repo only', () => {
    const result = { retiredNamesByRepo: { 'repo-1': ['nautilus'], 'repo-2': ['seahorse'] } }
    expect(readRetiredNameRegistryForRepo(result, 'repo-1')).toEqual({
      exhaustedTiers: 0,
      names: ['nautilus']
    })
  })

  it('carries the compaction watermark alongside the names', () => {
    const result = {
      retiredNamesByRepo: { 'repo-1': ['nautilus-2'] },
      retiredNameTiersByRepo: { 'repo-1': 1, 'repo-2': 3 }
    }
    expect(readRetiredNameRegistryForRepo(result, 'repo-1')).toEqual({
      exhaustedTiers: 1,
      names: ['nautilus-2']
    })
  })

  it.each([
    ['a host predating the watermark field', { retiredNamesByRepo: { 'repo-1': ['nautilus'] } }],
    [
      'a garbage watermark',
      {
        retiredNamesByRepo: { 'repo-1': ['nautilus'] },
        retiredNameTiersByRepo: { 'repo-1': 'lots' }
      }
    ]
  ])('degrades to no watermark for %s', (_label, result) => {
    expect(readRetiredNameRegistryForRepo(result, 'repo-1').exhaustedTiers).toBe(0)
  })

  it.each([
    ['a host predating the method', {}],
    ['a repo with no entry', { retiredNamesByRepo: { other: ['nautilus'] } }],
    ['a non-array row', { retiredNamesByRepo: { 'repo-1': 'nautilus' } }],
    ['a null result', null],
    ['a non-object result', 'nope']
  ])('answers empty for %s', (_label, result) => {
    expect(readRetiredNameRegistryForRepo(result, 'repo-1')).toEqual(EMPTY_RETIRED_NAME_REGISTRY)
  })

  it('drops non-string elements, which would throw when normalized', () => {
    const result = { retiredNamesByRepo: { 'repo-1': ['nautilus', 42, null, 'seahorse'] } }
    expect(readRetiredNameRegistryForRepo(result, 'repo-1').names).toEqual(['nautilus', 'seahorse'])
  })
})

describe('retiredNamesAfterRefresh', () => {
  it('takes the new registry on success', () => {
    expect(
      retiredNamesAfterRefresh(loadOf('repo-1', ['nautilus']), 'repo-1', {
        exhaustedTiers: 1,
        names: ['nautilus-2']
      })
    ).toEqual(loadOf('repo-1', ['nautilus-2'], 1))
  })

  // The divergence this module exists to close: mobile used to reset to [] here, which un-retires
  // every name in the window where the create form is asking for a suggestion.
  it('holds the previous registry when the refresh fails', () => {
    expect(retiredNamesAfterRefresh(loadOf('repo-1', ['nautilus'], 2), 'repo-1', null)).toEqual(
      loadOf('repo-1', ['nautilus'], 2)
    )
  })

  it('does not carry another repo forward through a failure', () => {
    expect(retiredNamesAfterRefresh(loadOf('repo-1', ['nautilus'], 2), 'repo-2', null)).toEqual({
      repoId: 'repo-2',
      registry: EMPTY_RETIRED_NAME_REGISTRY
    })
  })

  it('answers empty when the first fetch for a repo fails', () => {
    expect(retiredNamesAfterRefresh(null, 'repo-1', null).registry).toEqual(
      EMPTY_RETIRED_NAME_REGISTRY
    )
  })
})

describe('selectRetiredNameRegistry', () => {
  it('serves a load only to the repo it answered for', () => {
    const loaded = loadOf('repo-1', ['nautilus'], 1)
    expect(selectRetiredNameRegistry(loaded, 'repo-1')).toEqual(loaded.registry)
    expect(selectRetiredNameRegistry(loaded, 'repo-2')).toEqual(EMPTY_RETIRED_NAME_REGISTRY)
    expect(selectRetiredNameRegistry(loaded, null)).toEqual(EMPTY_RETIRED_NAME_REGISTRY)
    expect(selectRetiredNameRegistry(null, 'repo-1')).toEqual(EMPTY_RETIRED_NAME_REGISTRY)
  })

  it('returns the stored registry itself so downstream memos do not rerun', () => {
    const loaded = loadOf('repo-1', ['nautilus'])
    expect(selectRetiredNameRegistry(loaded, 'repo-1')).toBe(loaded.registry)
  })
})
