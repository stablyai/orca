import { describe, expect, it } from 'vitest'
import {
  filterAvailableTaskProviders,
  mergeRenderedVisibleTaskProviders,
  normalizeTaskProviderSettings,
  normalizeVisibleTaskProviders,
  resolveBeadsTaskProviderAvailability,
  restoreAvailableDefaultTaskProvider,
  resolveVisibleTaskProvider
} from './task-providers'

describe('task providers', () => {
  it('normalizes provider lists while preserving supported order', () => {
    expect(normalizeVisibleTaskProviders(['gitlab', 'unknown', 'gitlab', 'linear'])).toEqual([
      'gitlab',
      'linear'
    ])
  })

  it('falls back to all providers when none are visible', () => {
    expect(normalizeVisibleTaskProviders([])).toEqual([
      'github',
      'gitlab',
      'linear',
      'jira',
      'beads'
    ])
  })

  it('restores a valid saved default when provider settings drifted', () => {
    expect(
      normalizeTaskProviderSettings({
        visibleTaskProviders: ['linear'],
        defaultTaskSource: 'github'
      })
    ).toEqual({
      defaultTaskSource: 'github',
      visibleTaskProviders: ['github', 'linear']
    })
  })

  it('normalizes invalid saved defaults to the first visible provider', () => {
    expect(
      normalizeTaskProviderSettings({
        visibleTaskProviders: ['gitlab'],
        defaultTaskSource: 'bitbucket'
      })
    ).toEqual({
      defaultTaskSource: 'gitlab',
      visibleTaskProviders: ['gitlab']
    })
  })

  it('resolves hidden preferred providers to the first visible provider', () => {
    expect(resolveVisibleTaskProvider('github', ['linear'])).toBe('linear')
  })

  it('filters runtime-unavailable providers without changing preference normalization', () => {
    expect(
      filterAvailableTaskProviders(['github', 'gitlab', 'linear'], {
        gitlabInstalled: false,
        linearConnected: true,
        bdInstalled: false
      })
    ).toEqual(['github', 'linear'])
  })

  it('keeps an available saved default visible when provider visibility drifted', () => {
    expect(
      restoreAvailableDefaultTaskProvider(
        ['linear'],
        {
          gitlabInstalled: false,
          linearConnected: true,
          bdInstalled: false
        },
        'github'
      )
    ).toEqual(['github', 'linear'])
  })

  it('preserves intentionally narrowed providers when the saved default matches them', () => {
    expect(
      restoreAvailableDefaultTaskProvider(
        ['linear'],
        {
          gitlabInstalled: false,
          linearConnected: true,
          bdInstalled: false
        },
        'linear'
      )
    ).toEqual(['linear'])
  })

  it('does not restore an unavailable saved default', () => {
    expect(
      restoreAvailableDefaultTaskProvider(
        ['linear'],
        {
          gitlabInstalled: false,
          linearConnected: true,
          bdInstalled: false
        },
        'gitlab'
      )
    ).toEqual(['linear'])
  })

  it('ignores invalid saved defaults while restoring visible providers', () => {
    expect(
      restoreAvailableDefaultTaskProvider(
        ['gitlab'],
        {
          gitlabInstalled: false,
          linearConnected: true,
          bdInstalled: false
        },
        'bitbucket'
      )
    ).toEqual(['github'])
  })

  it('keeps beads available for ssh/runtime-hosted repos without a local bd', () => {
    expect(
      resolveBeadsTaskProviderAvailability({
        localBdInstalled: false,
        repoHostIds: ['local', 'ssh:target-1']
      })
    ).toBe(true)
    expect(
      resolveBeadsTaskProviderAvailability({
        localBdInstalled: false,
        repoHostIds: ['runtime:env-1']
      })
    ).toBe(true)
    expect(
      resolveBeadsTaskProviderAvailability({
        localBdInstalled: false,
        repoHostIds: ['local', null, undefined]
      })
    ).toBe(false)
    expect(resolveBeadsTaskProviderAvailability({ localBdInstalled: true, repoHostIds: [] })).toBe(
      true
    )
  })

  it('merges rendered picker options into the stored visible list in canonical order', () => {
    expect(mergeRenderedVisibleTaskProviders(['linear', 'gitlab'], ['jira', 'github'])).toEqual([
      'github',
      'gitlab',
      'linear',
      'jira'
    ])
  })

  it('dedupes overlapping stored and rendered providers', () => {
    expect(mergeRenderedVisibleTaskProviders(['github', 'linear'], ['linear', 'github'])).toEqual([
      'github',
      'linear'
    ])
  })

  it('keeps the merged list identical when rendered options are already stored', () => {
    expect(mergeRenderedVisibleTaskProviders(['github', 'gitlab', 'beads'], ['github'])).toEqual([
      'github',
      'gitlab',
      'beads'
    ])
  })

  it('restores a default-resurrected provider when the user switches source', () => {
    // Regression: stored list lost github long ago; the picker still rendered it
    // via the saved default, so switching to beads must persist github as visible.
    expect(
      mergeRenderedVisibleTaskProviders(['gitlab', 'linear', 'beads'], ['github', 'beads'])
    ).toEqual(['github', 'gitlab', 'linear', 'beads'])
  })

  it('falls back to GitHub when every preferred provider is unavailable', () => {
    expect(
      filterAvailableTaskProviders(['gitlab', 'linear'], {
        gitlabInstalled: false,
        linearConnected: false,
        bdInstalled: false
      })
    ).toEqual(['github'])
  })
})
