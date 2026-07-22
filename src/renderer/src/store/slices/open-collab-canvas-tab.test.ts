/**
 * Desktop dogfood path (store level): New Collab Board opens a collab-canvas
 * tab in a right split beside the active terminal group, bound by boardId.
 */
import { beforeEach, describe, expect, it } from 'vitest'
import { createTestStore } from './store-test-helpers'
import { collabCanvasSyncOrigin } from '../../lib/collab-canvas/collab-canvas-sync-config'
import { collabCanvasRoomUri } from '../../../../shared/collab-canvas-binding'
import { sessionCollabCanvasBinding } from '../../../../shared/collab-canvas-binding'

const WT = 'wt-collab-dogfood'

describe('openCollabCanvasTabInActiveWorkspace', () => {
  let store: ReturnType<typeof createTestStore>

  beforeEach(() => {
    store = createTestStore()
    store.setState({ activeWorktreeId: WT })
    store.getState().createUnifiedTab(WT, 'terminal', {
      id: 'term-dogfood',
      entityId: 'term-dogfood',
      label: 'Terminal'
    })
  })

  it('opens a collab-canvas tab in a right split (not editor fallthrough)', () => {
    const groupId = store.getState().groupsByWorktree[WT][0].id
    const created = store.getState().openCollabCanvasTabInActiveWorkspace(groupId)
    expect(created).not.toBeNull()
    expect(created!.contentType).toBe('collab-canvas')
    expect(created!.label).toBe('Collab Board')
    expect(created!.entityId).toMatch(/^[A-Za-z0-9._-]{1,64}$/)

    const state = store.getState()
    expect(state.activeTabType).toBe('collab-canvas')
    expect(created!.groupId).not.toBe(groupId)

    const layout = state.layoutByWorktree[WT]
    expect(layout.type).toBe('split')
    if (layout.type === 'split') {
      expect(layout.direction).toBe('horizontal')
    }

    // Session binding uses entityId as boardId
    const binding = sessionCollabCanvasBinding(WT, created!.entityId)
    expect(binding.kind).toBe('session')
    expect(binding.boardId).toBe(created!.entityId)

    // Room URI points at mesh node-a default — never a Cloudflare host
    const origin = collabCanvasSyncOrigin(null, null)
    expect(origin).toMatch(/^ws:\/\/node-a:5858$/)
    expect(origin).not.toMatch(/cloudflare|workers\.dev/i)
    const room = collabCanvasRoomUri(origin, created!.entityId)
    expect(room).toBe(`${origin}/connect/${created!.entityId}`)
  })

  it('opens a pinned panel board beside session with the same boardId', () => {
    const groupId = store.getState().groupsByWorktree[WT][0].id
    const boardId = 'panel-board-abc123'
    const created = store.getState().openPinnedCanvasBoardBesideSession({
      boardId,
      title: 'My whiteboard',
      groupId
    })
    expect(created).not.toBeNull()
    expect(created!.contentType).toBe('collab-canvas')
    expect(created!.entityId).toBe(boardId)
    expect(created!.label).toBe('My whiteboard')
    expect(created!.groupId).not.toBe(groupId)

    // Re-open activates the same tab (no duplicate sync clients for one board).
    const again = store.getState().openPinnedCanvasBoardBesideSession({
      boardId,
      title: 'My whiteboard',
      groupId
    })
    expect(again!.id).toBe(created!.id)
  })
})
