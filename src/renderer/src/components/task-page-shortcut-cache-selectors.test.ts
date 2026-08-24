import { describe, expect, it } from 'vitest'
import type { ShortcutStory } from '../../../shared/shortcut-types'
import {
  getTaskSourceCacheScope,
  normalizeTaskSourceContext
} from '../../../shared/task-source-context'
import { findTaskPageShortcutStory } from './task-page-shortcut-cache-selectors'

function story(id: string, workspaceId: string): ShortcutStory {
  return {
    id,
    workspaceId,
    title: `Story ${id}`,
    url: `https://app.shortcut.com/acme/story/${id}`,
    storyType: 'feature',
    state: { id: '101', name: 'In Progress', type: 'started' },
    labels: [],
    owners: [],
    archived: false,
    completed: false,
    started: true,
    updatedAt: '2026-08-20T10:00:00Z',
    createdAt: '2026-08-01T10:00:00Z'
  }
}

const SOURCE_CONTEXT = normalizeTaskSourceContext({
  provider: 'shortcut',
  projectId: 'project-1',
  hostId: 'local',
  providerIdentity: { provider: 'shortcut', workspaceId: 'ws-1', workspaceSlug: 'acme' }
})!
const SCOPE = getTaskSourceCacheScope(SOURCE_CONTEXT)

describe('findTaskPageShortcutStory', () => {
  it('finds a story in the scoped story cache', () => {
    const found = findTaskPageShortcutStory(
      { [`${SCOPE}::ws-1::42`]: { data: story('42', 'ws-1'), fetchedAt: 1 } },
      {},
      '42',
      { sourceContext: SOURCE_CONTEXT }
    )
    expect(found?.id).toBe('42')
  })

  it('refuses a same-id story cached for another source scope', () => {
    const found = findTaskPageShortcutStory(
      { 'other-scope::ws-9::42': { data: story('42', 'ws-9'), fetchedAt: 1 } },
      {},
      '42',
      { sourceContext: SOURCE_CONTEXT }
    )
    expect(found).toBeNull()
  })

  it('falls back to search-cache rows and honors the workspace filter', () => {
    const searchCache = {
      [`${SCOPE}::ws-1::query::30`]: {
        data: [story('42', 'ws-1'), story('43', 'ws-1')],
        fetchedAt: 1
      }
    }
    expect(
      findTaskPageShortcutStory({}, searchCache, '43', {
        sourceContext: SOURCE_CONTEXT,
        workspaceId: 'ws-1'
      })?.id
    ).toBe('43')
    expect(
      findTaskPageShortcutStory({}, searchCache, '43', {
        sourceContext: SOURCE_CONTEXT,
        workspaceId: 'ws-2'
      })
    ).toBeNull()
  })
})
