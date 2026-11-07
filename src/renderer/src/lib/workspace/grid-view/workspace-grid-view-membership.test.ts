import { describe, expect, it } from 'vitest'
import {
  WORKSPACE_GRID_VIEW_MAX_MEMBERS,
  addWorkspaceGridViewMember,
  isWorkspaceGridViewFull,
  removeWorkspaceGridViewMember,
  resolveVisibleWorkspaceIds
} from './workspace-grid-view-membership'

const fullBoard = Array.from(
  { length: WORKSPACE_GRID_VIEW_MAX_MEMBERS },
  (_, index) => `wt-${index}`
)
const known = (): boolean => true

describe('addWorkspaceGridViewMember', () => {
  it('seeds an empty grid view with the active workspace so the first add shows two panes', () => {
    expect(addWorkspaceGridViewMember([], 'b', 'a', known)).toEqual(['a', 'b'])
  })

  it('does not seed when the active workspace is the one being added', () => {
    expect(addWorkspaceGridViewMember([], 'a', 'a', known)).toEqual(['a'])
  })

  it('does not seed when nothing is active', () => {
    expect(addWorkspaceGridViewMember([], 'b', null, known)).toEqual(['b'])
  })

  it('appends to an existing grid view without reseeding the active workspace', () => {
    expect(addWorkspaceGridViewMember(['a', 'b'], 'c', 'z', known)).toEqual(['a', 'b', 'c'])
  })

  it('keeps the same array when the workspace is already a member', () => {
    const members = ['a', 'b']
    expect(addWorkspaceGridViewMember(members, 'b', 'a', known)).toBe(members)
  })

  it('refuses to grow past the member limit', () => {
    expect(addWorkspaceGridViewMember(fullBoard, 'extra', 'wt-0', known)).toBe(fullBoard)
    expect(isWorkspaceGridViewFull(fullBoard, known)).toBe(true)
  })

  it('drops members whose workspace is gone to make room at the limit', () => {
    const removed = new Set(['wt-1', 'wt-4'])
    const stillThere = (id: string) => !removed.has(id)
    expect(isWorkspaceGridViewFull(fullBoard, stillThere)).toBe(false)
    expect(addWorkspaceGridViewMember(fullBoard, 'extra', 'wt-0', stillThere)).toEqual([
      'wt-0',
      'wt-2',
      'wt-3',
      'wt-5',
      'extra'
    ])
  })

  it('reseeds from the active workspace when every saved member is gone', () => {
    const nothingKnown = () => false
    expect(isWorkspaceGridViewFull(fullBoard, nothingKnown)).toBe(false)
    expect(addWorkspaceGridViewMember(fullBoard, 'b', 'a', nothingKnown)).toEqual(['a', 'b'])
  })

  it('keeps unresolved members below the limit, since their host may only be reconnecting', () => {
    expect(
      addWorkspaceGridViewMember(['a', 'offline'], 'c', 'a', (id) => id !== 'offline')
    ).toEqual(['a', 'offline', 'c'])
  })
})

describe('removeWorkspaceGridViewMember', () => {
  it('removes one member and keeps the rest in order', () => {
    expect(removeWorkspaceGridViewMember(['a', 'b', 'c'], 'b')).toEqual(['a', 'c'])
  })

  it('clears a grid view that would be left with a single pane', () => {
    expect(removeWorkspaceGridViewMember(['a', 'b'], 'a')).toEqual([])
  })

  it('keeps the same array when the workspace is not a member', () => {
    const members = ['a', 'b']
    expect(removeWorkspaceGridViewMember(members, 'z')).toBe(members)
  })
})

describe('resolveVisibleWorkspaceIds', () => {
  const mountable = new Set(['a', 'b', 'c'])

  it('shows every mountable member while the active workspace is on the grid view', () => {
    expect(
      resolveVisibleWorkspaceIds({
        gridViewMemberIds: ['a', 'b', 'c'],
        activeWorkspaceId: 'b',
        mountableWorkspaceIds: mountable
      })
    ).toEqual(['a', 'b', 'c'])
  })

  it('shows only the active workspace when it is not on the grid view', () => {
    expect(
      resolveVisibleWorkspaceIds({
        gridViewMemberIds: ['a', 'b'],
        activeWorkspaceId: 'c',
        mountableWorkspaceIds: mountable
      })
    ).toEqual(['c'])
  })

  it('skips members that no longer have a surface, such as removed workspaces', () => {
    expect(
      resolveVisibleWorkspaceIds({
        gridViewMemberIds: ['a', 'gone', 'c'],
        activeWorkspaceId: 'a',
        mountableWorkspaceIds: mountable
      })
    ).toEqual(['a', 'c'])
  })

  it('falls back to the active workspace when fewer than two members can mount', () => {
    expect(
      resolveVisibleWorkspaceIds({
        gridViewMemberIds: ['a', 'gone'],
        activeWorkspaceId: 'a',
        mountableWorkspaceIds: mountable
      })
    ).toEqual(['a'])
  })

  it('shows nothing when no workspace is active', () => {
    expect(
      resolveVisibleWorkspaceIds({
        gridViewMemberIds: ['a', 'b'],
        activeWorkspaceId: null,
        mountableWorkspaceIds: mountable
      })
    ).toEqual([])
  })
})
