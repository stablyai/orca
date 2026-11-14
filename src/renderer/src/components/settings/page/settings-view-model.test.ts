import { describe, expect, it } from 'vitest'
import { SlidersHorizontal } from 'lucide-react'
import { buildSettingsViewModel } from './settings-view-model'

describe('Settings project navigation', () => {
  it('shows group hook settings alongside repository settings', () => {
    const view = buildSettingsViewModel(
      { repos: [], settingsSearchQuery: '', activeSectionId: 'group-local%3Ateam' },
      {
        visibleNavSections: [
          {
            id: 'group-local%3Ateam',
            title: 'Team (This Mac)',
            description: '/team',
            searchEntries: [],
            icon: SlidersHorizontal,
            group: 'repositories'
          },
          {
            id: 'repo-app',
            title: 'App',
            description: '/team/app',
            searchEntries: [],
            icon: SlidersHorizontal,
            group: 'repositories'
          }
        ],
        neededSectionIds: new Set(['group-local%3Ateam'])
      }
    )

    expect(view.repoNavSections.map((section) => section.id)).toEqual([
      'group-local%3Ateam',
      'repo-app'
    ])
  })
})
