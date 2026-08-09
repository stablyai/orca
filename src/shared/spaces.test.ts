import { describe, expect, it } from 'vitest'
import {
  DEFAULT_SPACE_FALLBACK_NAME,
  DEFAULT_SPACE_ID,
  clearMissingSpaceMemberships,
  createDefaultSpace,
  createSpace,
  createSpaceWorkspaceSelectionKey,
  getSpaceById,
  hasCustomSpaces,
  isDefaultSpaceId,
  isRepoInSpace,
  limitSpaceName,
  normalizeActiveSpaceId,
  normalizeLastWorkspaceKeyBySpaceId,
  normalizeSpaceEmoji,
  normalizeSpaceName,
  normalizeSpaces,
  parseSpaceWorkspaceSelectionKey,
  resolveSpaceId
} from './spaces'
import type { Repo, Space } from './types'

const FAMILY = '👨‍👩‍👧'
const ENGLAND_FLAG = '🏴\u{E0067}\u{E0062}\u{E0065}\u{E006E}\u{E0067}\u{E007F}'

function space(id: string, overrides: Partial<Space> = {}): Space {
  return { id, name: id, emoji: null, createdAt: 1, updatedAt: 1, ...overrides }
}

function repo(id: string, spaceId?: string | null): Repo {
  return {
    id,
    path: `/repos/${id}`,
    displayName: id,
    badgeColor: '#000',
    addedAt: 0,
    ...(spaceId === undefined ? {} : { spaceId })
  }
}

describe('Space value normalization', () => {
  it('normalizes names and caps them without splitting graphemes', () => {
    expect(normalizeSpaceName('  Work  ')).toBe('Work')
    expect(normalizeSpaceName('   ')).toBe('Untitled space')
    expect(normalizeSpaceName(null)).toBe('Untitled space')
    expect(normalizeSpaceName(`${'a'.repeat(59)}😀tail`)).toBe(`${'a'.repeat(59)}😀`)
    expect(normalizeSpaceName(`${'a'.repeat(59)}${FAMILY}${FAMILY}`)).toBe(
      `${'a'.repeat(59)}${FAMILY}`
    )
    expect(limitSpaceName(` ${'a'.repeat(60)}`)).toBe(` ${'a'.repeat(59)}`)
  })

  it.each([
    [FAMILY, FAMILY],
    ['❤️', '❤️'],
    [ENGLAND_FLAG, ENGLAND_FLAG],
    ['🚀🔥', '🚀'],
    [` ${FAMILY}🔥 `, FAMILY]
  ])('keeps one complete emoji grapheme from %s', (input, expected) => {
    expect(normalizeSpaceEmoji(input)).toBe(expected)
  })

  it('rejects missing, blank, non-string, and control-only emoji values', () => {
    for (const value of [undefined, null, '', '  ', 7, ['🚀'], '\u200B']) {
      expect(normalizeSpaceEmoji(value)).toBeNull()
    }
  })
})

describe('Space catalog normalization', () => {
  it('repairs malformed catalogs, deduplicates ids, and keeps Default first', () => {
    const spaces = normalizeSpaces([
      space('space-b', { createdAt: 2 }),
      { id: 'space-a', name: '   ', emoji: '🚀🔥', createdAt: 1, updatedAt: 1 },
      space('space-a', { name: 'duplicate' }),
      { name: 'missing id' },
      null
    ])

    expect(spaces.map((entry) => entry.id)).toEqual([DEFAULT_SPACE_ID, 'space-a', 'space-b'])
    expect(spaces[0]).toMatchObject({ name: DEFAULT_SPACE_FALLBACK_NAME, emoji: null })
    expect(spaces[1]).toMatchObject({ name: 'Untitled space', emoji: '🚀' })
  })

  it('creates normalized custom Spaces and a stable Default Space', () => {
    const first = createSpace({ name: '  Work  ', emoji: '🧪🧨', now: 10 })
    const second = createSpace({ name: 'Side', now: 20 })
    const defaultSpace = createDefaultSpace(5)

    expect(first).toMatchObject({ name: 'Work', emoji: '🧪', createdAt: 10, updatedAt: 10 })
    expect(first.id).not.toBe(second.id)
    expect(defaultSpace).toEqual({
      id: DEFAULT_SPACE_ID,
      name: DEFAULT_SPACE_FALLBACK_NAME,
      emoji: null,
      createdAt: 5,
      updatedAt: 5
    })
    expect(hasCustomSpaces([defaultSpace])).toBe(false)
    expect(hasCustomSpaces([defaultSpace, first])).toBe(true)
    expect(getSpaceById([defaultSpace, first], first.id)).toBe(first)
  })
})

describe('Space membership', () => {
  it('treats absent membership as Default and explicit membership as exclusive', () => {
    expect(resolveSpaceId(null)).toBe(DEFAULT_SPACE_ID)
    expect(resolveSpaceId('space-work')).toBe('space-work')
    expect(isDefaultSpaceId(undefined)).toBe(true)
    expect(isRepoInSpace(repo('default'), DEFAULT_SPACE_ID)).toBe(true)
    expect(isRepoInSpace(repo('work', 'space-work'), 'space-work')).toBe(true)
    expect(isRepoInSpace(repo('work', 'space-work'), DEFAULT_SPACE_ID)).toBe(false)
  })

  it('clears only memberships whose Space disappeared', () => {
    const valid = repo('valid', 'space-work')
    const unassigned = repo('default')
    const result = clearMissingSpaceMemberships(
      [valid, unassigned, repo('stale', 'space-gone')],
      [createDefaultSpace(), space('space-work')]
    )

    expect(result[0]).toBe(valid)
    expect(result[1]).toBe(unassigned)
    expect(result[2]?.spaceId).toBeNull()
  })
})

describe('persisted Space UI state', () => {
  const spaces = [createDefaultSpace(), space('space-work')]

  it('falls back unknown active ids and prunes invalid remembered selections', () => {
    expect(normalizeActiveSpaceId('space-work', spaces)).toBe('space-work')
    expect(normalizeActiveSpaceId('space-gone', spaces)).toBe(DEFAULT_SPACE_ID)
    expect(
      normalizeLastWorkspaceKeyBySpaceId(
        {
          [DEFAULT_SPACE_ID]: 'folder:folder-1',
          'space-work': 'ssh:server\0worktree:worktree-1',
          'space-gone': 'worktree:gone',
          invalid: 'not-a-workspace'
        },
        spaces
      )
    ).toEqual({
      [DEFAULT_SPACE_ID]: 'folder:folder-1',
      'space-work': 'ssh:server\0worktree:worktree-1'
    })
  })

  it('round-trips host-qualified selections while accepting legacy keys', () => {
    const qualified = createSpaceWorkspaceSelectionKey('worktree:worktree-1', 'ssh:server')

    expect(parseSpaceWorkspaceSelectionKey(qualified)).toEqual({
      workspaceKey: 'worktree:worktree-1',
      hostId: 'ssh:server'
    })
    expect(parseSpaceWorkspaceSelectionKey('folder:folder-1')).toEqual({
      workspaceKey: 'folder:folder-1'
    })
    expect(parseSpaceWorkspaceSelectionKey('bad')).toBeNull()
  })
})
