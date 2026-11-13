import { Settings } from 'lucide-react'
import { expect, it } from 'vitest'
import type { SettingsNavSection } from './settings-navigation-types'
import {
  buildSettingsSearchResults,
  getSettingsSearchTitleMatchRanges,
  rankSettingsSearchResults
} from './settings-search-results'

function section(
  id: string,
  title: string,
  searchEntries: SettingsNavSection['searchEntries']
): SettingsNavSection {
  return { id, title, description: '', icon: Settings, group: 'interface', searchEntries }
}

it('ranks individual settings across panes and targets each one', () => {
  const results = buildSettingsSearchResults(
    [
      section('general', 'General', [
        { title: 'Auto update', keywords: ['release'] },
        { title: 'Auto update' },
        { title: 'Theme', keywords: ['update'] }
      ]),
      section('updates', 'Updates', [{ title: 'Channel', targetSectionId: 'updates-channel' }]),
      section('repo-1', 'orca', [{ title: 'Update hooks' }])
    ],
    (_section, entry) => (entry.title === 'Theme' ? 'general-theme' : undefined)
  )

  expect(
    rankSettingsSearchResults('update', results).map((result) => [
      result.section.id,
      result.entry.title,
      result.targetId
    ])
  ).toEqual([
    ['updates', 'Updates', 'updates'],
    ['repo-1', 'Update hooks', 'settings-title:Update hooks'],
    ['general', 'Auto update', 'settings-title:Auto update'],
    ['general', 'Theme', 'general-theme']
  ])
  expect(rankSettingsSearchResults('channel', results)[0]?.targetId).toBe('updates-channel')
  expect(rankSettingsSearchResults('  ', results)).toEqual([])
})

it('marks the same text the ranking fold matched, including dotted capital I', () => {
  expect(getSettingsSearchTitleMatchRanges('İstanbul', 'stan')).toEqual([{ start: 1, end: 5 }])
  expect(getSettingsSearchTitleMatchRanges('İstanbul', 'İst')).toEqual([{ start: 0, end: 3 }])
  expect(getSettingsSearchTitleMatchRanges('Line height', 'İ')).toEqual([{ start: 1, end: 2 }])
  expect(getSettingsSearchTitleMatchRanges('Theme', 'update')).toEqual([])
})
