import { describe, expect, it } from 'vitest'
import {
  filterAvailableTaskProviders,
  isTaskProvider,
  normalizeTaskProviderSettings,
  normalizeVisibleTaskProviders,
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
      'kanban'
    ])
  })

  it('accepts Kanban as a valid provider', () => {
    expect(isTaskProvider('kanban')).toBe(true)
    expect(isTaskProvider('bitbucket')).toBe(false)
    expect(normalizeVisibleTaskProviders(['kanban'])).toEqual(['kanban'])
    expect(
      normalizeTaskProviderSettings({
        visibleTaskProviders: ['kanban'],
        defaultTaskSource: 'kanban'
      })
    ).toEqual({
      defaultTaskSource: 'kanban',
      visibleTaskProviders: ['kanban']
    })
  })

  it('makes Kanban available exactly when the connection flag says so', () => {
    expect(
      filterAvailableTaskProviders(['github', 'kanban'], {
        gitlabInstalled: false,
        linearConnected: false,
        kanbanConnected: true
      })
    ).toEqual(['github', 'kanban'])
    expect(
      filterAvailableTaskProviders(['github', 'kanban'], {
        gitlabInstalled: false,
        linearConnected: false,
        kanbanConnected: false
      })
    ).toEqual(['github'])
  })

  it('restores a Kanban saved default only when connected', () => {
    expect(
      restoreAvailableDefaultTaskProvider(
        ['kanban'],
        {
          gitlabInstalled: false,
          linearConnected: false,
          kanbanConnected: true
        },
        'kanban'
      )
    ).toEqual(['kanban'])
    expect(
      restoreAvailableDefaultTaskProvider(
        ['kanban'],
        {
          gitlabInstalled: false,
          linearConnected: false,
          kanbanConnected: false
        },
        'kanban'
      )
    ).toEqual(['github'])
  })

  it('keeps every other provider availability unchanged by the Kanban flag', () => {
    const withKanbanTrue = {
      gitlabInstalled: false,
      linearConnected: false,
      kanbanConnected: true
    }
    const withKanbanFalse = {
      gitlabInstalled: false,
      linearConnected: false,
      kanbanConnected: false
    }
    for (const availability of [withKanbanTrue, withKanbanFalse]) {
      expect(filterAvailableTaskProviders(['gitlab'], availability)).toEqual(['github'])
      expect(filterAvailableTaskProviders(['linear'], availability)).toEqual(['github'])
      expect(filterAvailableTaskProviders(['github', 'jira'], availability)).toEqual([
        'github',
        'jira'
      ])
      expect(filterAvailableTaskProviders(['github', 'gitlab', 'linear'], availability)).toEqual([
        'github'
      ])
    }
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
        kanbanConnected: false
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
          kanbanConnected: false
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
          kanbanConnected: false
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
          kanbanConnected: false
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
          kanbanConnected: false
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
        kanbanConnected: false
      })
    ).toEqual(['github'])
  })
})
