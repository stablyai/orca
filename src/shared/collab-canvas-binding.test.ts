import { describe, expect, it } from 'vitest'
import {
  collabCanvasExportPath,
  collabCanvasOwnsAgentSession,
  collabCanvasRoomUri,
  collabCanvasSessionDirName,
  type CollabCanvasBinding
} from './collab-canvas-binding'

const panelBinding: CollabCanvasBinding = { kind: 'panel', panelId: 'p1', boardId: 'b1' }
const sessionBinding: CollabCanvasBinding = { kind: 'session', worktreeId: 'w1', boardId: 'b2' }

describe('collabCanvasRoomUri', () => {
  it('joins one room per board so every surface shares the document', () => {
    expect(collabCanvasRoomUri('ws://node-a:5858', 'b1')).toBe('ws://node-a:5858/connect/b1')
  })

  it('gives the desktop and the tablet the same room for one board', () => {
    // This is the whole point of sync: the tablet is not handed a copy.
    expect(collabCanvasRoomUri('ws://node-a:5858', 'b1')).toBe(
      collabCanvasRoomUri('ws://node-a:5858/', 'b1')
    )
  })

  it('keeps distinct boards in distinct rooms', () => {
    expect(collabCanvasRoomUri('ws://node-a:5858', 'b1')).not.toBe(
      collabCanvasRoomUri('ws://node-a:5858', 'b2')
    )
  })

  it('escapes a board id rather than letting it shape the path', () => {
    expect(collabCanvasRoomUri('ws://node-a:5858', 'a b/c')).toBe(
      'ws://node-a:5858/connect/a%20b%2Fc'
    )
  })
})

describe('collabCanvasExportPath', () => {
  it('keeps $HOME literal so it resolves on the board owner host', () => {
    // Resolving $HOME here would produce the coordinating host's home dir,
    // which is wrong for an SSH/remote worktree.
    expect(collabCanvasExportPath('b1')).toBe('$HOME/.local/state/meshina/collab-canvas/b1.json')
  })

  it('gives each board its own export file', () => {
    expect(collabCanvasExportPath('b1')).not.toBe(collabCanvasExportPath('b2'))
  })
})

describe('collabCanvasSessionDirName', () => {
  it('names a session dir for a panel board', () => {
    expect(collabCanvasSessionDirName(panelBinding)).toBe('canvas-b1')
  })

  it('gives a session board none — its agent thread belongs to the terminal', () => {
    expect(collabCanvasSessionDirName(sessionBinding)).toBeNull()
  })
})

describe('collabCanvasOwnsAgentSession', () => {
  it('lets a panel board reset and close its own agent', () => {
    expect(collabCanvasOwnsAgentSession(panelBinding)).toBe(true)
  })

  it('refuses for a session board — closing it would kill the working terminal', () => {
    expect(collabCanvasOwnsAgentSession(sessionBinding)).toBe(false)
  })
})
