import { describe, expect, it } from 'vitest'
import {
  COLLAB_CANVAS_SYNC_PORT,
  DEFAULT_COLLAB_CANVAS_SYNC_HOST,
  collabCanvasSyncOrigin,
  isValidCollabCanvasBoardId
} from './collab-canvas-sync-config'
import { collabCanvasRoomUri } from '../../../../shared/collab-canvas-binding'

describe('collabCanvasSyncOrigin', () => {
  it('falls back to the default mesh node when there is no paired host', () => {
    expect(collabCanvasSyncOrigin(null)).toBe(
      `ws://${DEFAULT_COLLAB_CANVAS_SYNC_HOST}:${COLLAB_CANVAS_SYNC_PORT}`
    )
    expect(collabCanvasSyncOrigin(undefined)).toBe(
      `ws://${DEFAULT_COLLAB_CANVAS_SYNC_HOST}:${COLLAB_CANVAS_SYNC_PORT}`
    )
  })

  it('derives the host from the paired host endpoint', () => {
    expect(collabCanvasSyncOrigin('ws://100.92.56.51:8080/x')).toBe(
      `ws://100.92.56.51:${COLLAB_CANVAS_SYNC_PORT}`
    )
  })

  it('lets an operator override win over the paired host', () => {
    expect(collabCanvasSyncOrigin('ws://100.92.56.51:8080', 'ws://node-e:9999')).toBe(
      'ws://node-e:9999'
    )
  })

  it('accepts a bare host:port override without a scheme', () => {
    // The operator will type this form; requiring ws:// would just be a trap.
    expect(collabCanvasSyncOrigin(null, 'node-e:9999')).toBe('ws://node-e:9999')
  })

  it('ignores a blank override rather than producing ws://', () => {
    expect(collabCanvasSyncOrigin(null, '   ')).toBe(
      `ws://${DEFAULT_COLLAB_CANVAS_SYNC_HOST}:${COLLAB_CANVAS_SYNC_PORT}`
    )
  })

  it('never leaves a trailing slash for the room path to double up on', () => {
    expect(collabCanvasSyncOrigin(null, 'ws://node-e:9999/')).toBe('ws://node-e:9999')
  })
})

describe('board id validation', () => {
  it('accepts the ids the server accepts', () => {
    expect(isValidCollabCanvasBoardId('board-1')).toBe(true)
    expect(isValidCollabCanvasBoardId('a.b_c-1')).toBe(true)
  })

  it('rejects what the server would destroy the socket over', () => {
    // Failing in the UI beats a silently dropped connection.
    for (const bad of ['../escape', 'a/b', 'has space', '', 'x'.repeat(65)]) {
      expect(isValidCollabCanvasBoardId(bad)).toBe(false)
    }
  })
})

describe('origin + room uri compose into the server contract', () => {
  it('produces the /connect/<boardId> path the sidecar routes on', () => {
    // The sidecar matches ^/connect/([^/]+)$ — this pair is the contract, so
    // a change on either side has to break this test.
    expect(collabCanvasRoomUri(collabCanvasSyncOrigin(null), 'board-1')).toBe(
      `ws://${DEFAULT_COLLAB_CANVAS_SYNC_HOST}:${COLLAB_CANVAS_SYNC_PORT}/connect/board-1`
    )
  })
})
