import { describe, it, expect } from 'vitest'
import {
  WORKSPACE_GROUP_COLOR_IDS,
  DEFAULT_WORKSPACE_GROUP_COLOR,
  createWorkspaceGroup,
  sanitizeWorkspaceGroup,
  normalizeWorkspaceGroups,
  clearWorkspaceGroupFromMeta,
  pickAutoCycledColor
} from './workspace-groups'
import type { WorkspaceGroup, WorktreeMeta } from './types'

describe('workspace-groups palette', () => {
  it('exposes exactly the 8 allowed colors', () => {
    expect(WORKSPACE_GROUP_COLOR_IDS).toEqual([
      'neutral',
      'blue',
      'sky',
      'violet',
      'amber',
      'emerald',
      'rose',
      'zinc'
    ])
  })

  it('defaults to neutral', () => {
    expect(DEFAULT_WORKSPACE_GROUP_COLOR).toBe('neutral')
  })
})

describe('createWorkspaceGroup', () => {
  it('returns a populated group with given name and color', () => {
    const g = createWorkspaceGroup({ name: 'Acme Checkout', color: 'blue', sortOrder: 2 })
    expect(g.id).toMatch(/^wg_/)
    expect(g.name).toBe('Acme Checkout')
    expect(g.color).toBe('blue')
    expect(g.sortOrder).toBe(2)
    expect(typeof g.createdAt).toBe('number')
    expect(g.collapsed).toBe(false)
  })

  it('clamps an empty name into a fallback', () => {
    const g = createWorkspaceGroup({ name: '   ', color: 'blue', sortOrder: 0 })
    expect(g.name).toBe('Untitled group')
  })
})

describe('sanitizeWorkspaceGroup', () => {
  it('clamps unknown colors to neutral', () => {
    const g = sanitizeWorkspaceGroup({
      id: 'wg_1',
      name: 'Feature',
      color: 'crimson' as unknown as 'neutral',
      sortOrder: 0,
      createdAt: 0
    })
    expect(g.color).toBe('neutral')
  })

  it('trims and length-limits names', () => {
    const longName = 'x'.repeat(200)
    const g = sanitizeWorkspaceGroup({
      id: 'wg_1',
      name: `  ${longName}  `,
      color: 'blue',
      sortOrder: 0,
      createdAt: 0
    })
    expect(g.name.length).toBeLessThanOrEqual(64)
    expect(g.name.startsWith('x')).toBe(true)
  })

  it('replaces empty name with Untitled group', () => {
    const g = sanitizeWorkspaceGroup({
      id: 'wg_1',
      name: '   ',
      color: 'blue',
      sortOrder: 0,
      createdAt: 0
    })
    expect(g.name).toBe('Untitled group')
  })
})

describe('normalizeWorkspaceGroups', () => {
  it('returns an empty array for undefined input', () => {
    expect(normalizeWorkspaceGroups(undefined)).toEqual([])
  })

  it('drops entries without an id', () => {
    const result = normalizeWorkspaceGroups([
      { id: '', name: 'x', color: 'blue', sortOrder: 0, createdAt: 0 } as unknown as WorkspaceGroup,
      { id: 'wg_a', name: 'A', color: 'blue', sortOrder: 0, createdAt: 0 }
    ])
    expect(result).toHaveLength(1)
    expect(result[0]!.id).toBe('wg_a')
  })

  it('deduplicates by id keeping first occurrence', () => {
    const result = normalizeWorkspaceGroups([
      { id: 'wg_a', name: 'First', color: 'blue', sortOrder: 0, createdAt: 1 },
      { id: 'wg_a', name: 'Second', color: 'rose', sortOrder: 1, createdAt: 2 }
    ])
    expect(result).toHaveLength(1)
    expect(result[0]!.name).toBe('First')
  })

  it('orders entries by sortOrder ascending', () => {
    const result = normalizeWorkspaceGroups([
      { id: 'b', name: 'B', color: 'blue', sortOrder: 2, createdAt: 0 },
      { id: 'a', name: 'A', color: 'blue', sortOrder: 1, createdAt: 0 }
    ])
    expect(result.map((g) => g.id)).toEqual(['a', 'b'])
  })
})

describe('clearWorkspaceGroupFromMeta', () => {
  it('returns a meta record with workspaceGroupId cleared on every member', () => {
    const meta: Record<string, WorktreeMeta> = {
      a: { displayName: 'A', workspaceGroupId: 'wg_x' } as WorktreeMeta,
      b: { displayName: 'B', workspaceGroupId: 'wg_x' } as WorktreeMeta,
      c: { displayName: 'C', workspaceGroupId: 'wg_y' } as WorktreeMeta,
      d: { displayName: 'D' } as WorktreeMeta
    }
    const cleared = clearWorkspaceGroupFromMeta(meta, 'wg_x')
    expect(cleared.a!.workspaceGroupId).toBeNull()
    expect(cleared.b!.workspaceGroupId).toBeNull()
    expect(cleared.c!.workspaceGroupId).toBe('wg_y')
    expect(cleared.d!.workspaceGroupId).toBeUndefined()
  })

  it('does not mutate the input record', () => {
    const meta: Record<string, WorktreeMeta> = {
      a: { displayName: 'A', workspaceGroupId: 'wg_x' } as WorktreeMeta
    }
    clearWorkspaceGroupFromMeta(meta, 'wg_x')
    expect(meta.a!.workspaceGroupId).toBe('wg_x')
  })
})

describe('pickAutoCycledColor', () => {
  it('returns the next palette color after the most recently used one', () => {
    expect(pickAutoCycledColor([])).toBe('neutral')
    expect(pickAutoCycledColor(['neutral'])).toBe('blue')
    expect(pickAutoCycledColor(['neutral', 'blue', 'sky'])).toBe('violet')
  })

  it('wraps to start after the last color', () => {
    expect(
      pickAutoCycledColor(['neutral', 'blue', 'sky', 'violet', 'amber', 'emerald', 'rose', 'zinc'])
    ).toBe('neutral')
  })
})
