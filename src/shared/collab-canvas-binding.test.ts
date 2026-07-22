import { describe, expect, it } from 'vitest'
import {
  collabCanvasOwnsAgentSession,
  collabCanvasSessionDirName,
  collabCanvasSnapshotPath,
  type CollabCanvasBinding
} from './collab-canvas-binding'

const panelBinding: CollabCanvasBinding = { kind: 'panel', panelId: 'p1', boardId: 'b1' }
const sessionBinding: CollabCanvasBinding = { kind: 'session', worktreeId: 'w1', boardId: 'b2' }

describe('collabCanvasSnapshotPath', () => {
  it('keeps $HOME literal so it resolves on the board owner host', () => {
    // Resolving $HOME here would produce the coordinating host's home dir,
    // which is wrong for an SSH/remote worktree.
    expect(collabCanvasSnapshotPath('b1')).toBe(
      '$HOME/.local/state/meshina/collab-canvas/b1.json'
    )
  })

  it('gives each board its own snapshot', () => {
    expect(collabCanvasSnapshotPath('b1')).not.toBe(collabCanvasSnapshotPath('b2'))
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
