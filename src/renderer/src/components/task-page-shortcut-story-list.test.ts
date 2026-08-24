import { describe, expect, it } from 'vitest'
import type { ShortcutStory, ShortcutWorkflow } from '../../../shared/shortcut-types'
import { groupShortcutStoriesByState } from './task-page-shortcut-story-list'

function story(id: string, stateId: string, stateName: string): ShortcutStory {
  return {
    id,
    title: `Story ${id}`,
    url: `https://app.shortcut.com/acme/story/${id}`,
    storyType: 'feature',
    state: { id: stateId, name: stateName, type: 'started' },
    labels: [],
    owners: [],
    archived: false,
    completed: false,
    started: true,
    updatedAt: '2026-08-20T10:00:00Z',
    createdAt: '2026-08-01T10:00:00Z'
  }
}

const WORKFLOWS: ShortcutWorkflow[] = [
  {
    id: '7',
    name: 'Engineering',
    states: [
      { id: '100', name: 'To Do', type: 'unstarted', position: 0 },
      { id: '101', name: 'In Progress', type: 'started', position: 1 },
      { id: '102', name: 'Done', type: 'done', position: 2 }
    ]
  }
]

describe('groupShortcutStoriesByState', () => {
  it('groups by state name ordered by workflow position', () => {
    const sections = groupShortcutStoriesByState(
      [story('1', '102', 'Done'), story('2', '100', 'To Do'), story('3', '101', 'In Progress')],
      WORKFLOWS
    )
    expect(sections.map((section) => section.label)).toEqual(['To Do', 'In Progress', 'Done'])
  })

  it('falls back to alphabetical order for states outside the loaded workflows', () => {
    const sections = groupShortcutStoriesByState(
      [story('1', '901', 'Zeta'), story('2', '902', 'Alpha')],
      []
    )
    expect(sections.map((section) => section.label)).toEqual(['Alpha', 'Zeta'])
  })

  it('keeps every story of one state in a single section', () => {
    const sections = groupShortcutStoriesByState(
      [story('1', '101', 'In Progress'), story('2', '101', 'In Progress')],
      WORKFLOWS
    )
    expect(sections).toHaveLength(1)
    expect(sections[0]?.stories.map((entry) => entry.id)).toEqual(['1', '2'])
  })
})
