import { describe, expect, it } from 'vitest'
import { buildSessionBoardAwarenessText } from './session-awareness'

describe('buildSessionBoardAwarenessText', () => {
  it('names board and worktree and forbids second agent', () => {
    const text = buildSessionBoardAwarenessText({
      boardId: 'board-x',
      worktreeId: 'wt-y'
    })
    expect(text).toContain('[collab-canvas awareness]')
    expect(text).toContain('board-x')
    expect(text).toContain('wt-y')
    expect(text).toContain('no second agent')
    expect(text).toContain('Send to session')
  })
})
