import { describe, expect, it } from 'vitest'
import {
  filterAvailableTaskProviders,
  isTaskProviderAvailable,
  normalizeTaskProviderSettings,
  normalizeVisibleTaskProviders,
  orderTaskProviders,
  resolveVisibleTaskProvider,
  restoreAvailableDefaultTaskProvider
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
      'huly'
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
        hulyConnected: false
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
          hulyConnected: false
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
          hulyConnected: false
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
          hulyConnected: false
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
          hulyConnected: false
        },
        'bitbucket'
      )
    ).toEqual(['github'])
  })

  it('falls back to GitHub when every preferred provider is unavailable', () => {
    expect(
      filterAvailableTaskProviders(['gitlab', 'linear'], {
        gitlabInstalled: false,
        linearConnected: false,
        hulyConnected: false
      })
    ).toEqual(['github'])
  })

  it('hides Huly when the connection status is not connected', () => {
    expect(
      filterAvailableTaskProviders(['github', 'huly'], {
        gitlabInstalled: false,
        linearConnected: false,
        hulyConnected: false
      })
    ).toEqual(['github'])
  })

  it('keeps Huly visible when hulyConnected is true', () => {
    expect(
      filterAvailableTaskProviders(['github', 'huly'], {
        gitlabInstalled: false,
        linearConnected: false,
        hulyConnected: true
      })
    ).toEqual(['github', 'huly'])
  })

  it('isTaskProviderAvailable returns true for Huly only when hulyConnected', () => {
    expect(
      isTaskProviderAvailable('huly', {
        gitlabInstalled: false,
        linearConnected: false,
        hulyConnected: false
      })
    ).toBe(false)
    expect(
      isTaskProviderAvailable('huly', {
        gitlabInstalled: false,
        linearConnected: false,
        hulyConnected: true
      })
    ).toBe(true)
  })

  it('orderTaskProviders leaves Huly in its slot when not connected', () => {
    expect(
      orderTaskProviders(['github', 'gitlab', 'linear', 'jira', 'huly'], {
        gitlabInstalled: true,
        linearConnected: true,
        hulyConnected: false
      })
    ).toEqual(['github', 'gitlab', 'linear', 'jira', 'huly'])
  })

  it('orderTaskProviders promotes Huly to position 0 when connected', () => {
    expect(
      orderTaskProviders(['github', 'gitlab', 'linear', 'jira', 'huly'], {
        gitlabInstalled: true,
        linearConnected: true,
        hulyConnected: true
      })
    ).toEqual(['huly', 'github', 'gitlab', 'linear', 'jira'])
  })

  it('orderTaskProviders does not promote Huly when it is not in the visible list', () => {
    expect(
      orderTaskProviders(['github', 'gitlab', 'linear', 'jira'], {
        gitlabInstalled: true,
        linearConnected: true,
        hulyConnected: true
      })
    ).toEqual(['github', 'gitlab', 'linear', 'jira'])
  })

  it('orderTaskProviders tolerates a missing availability argument', () => {
    expect(
      orderTaskProviders(['github', 'huly'], {
        gitlabInstalled: false,
        linearConnected: false,
        hulyConnected: false
      })
    ).toEqual(['github', 'huly'])
  })

  it('resolveVisibleTaskProvider honors the saved preference when explicit', () => {
    expect(
      resolveVisibleTaskProvider('github', ['github', 'linear', 'huly'], {
        gitlabInstalled: false,
        linearConnected: false,
        hulyConnected: true
      })
    ).toBe('github')
  })

  it('resolveVisibleTaskProvider honors the saved preference when Huly is not connected', () => {
    expect(
      resolveVisibleTaskProvider('linear', ['github', 'linear', 'huly'], {
        gitlabInstalled: false,
        linearConnected: true,
        hulyConnected: false
      })
    ).toBe('linear')
  })
})
