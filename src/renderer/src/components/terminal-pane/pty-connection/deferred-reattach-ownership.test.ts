import { describe, expect, it } from 'vitest'
import { collectPtyIdsOwnedByOtherWorktrees } from './deferred-reattach-ownership'

const OWN = 'repo::/dest'
const SPAWN = 'repo::/spawn'

describe('collectPtyIdsOwnedByOtherWorktrees', () => {
  it('claims PTYs held by rows in other worktrees', () => {
    const claimed = collectPtyIdsOwnedByOtherWorktrees(
      {
        tabsByWorktree: {
          [OWN]: [{ id: 'tab-own', ptyId: 'pty-own' }],
          [SPAWN]: [{ id: 'tab-moved', ptyId: 'pty-moved' }]
        }
      },
      OWN
    )

    expect(claimed).toEqual(new Set(['pty-moved']))
    expect(claimed.has('pty-own')).toBe(false)
  })

  it('claims leaf-level live PTY ids owned by other worktree tabs', () => {
    const claimed = collectPtyIdsOwnedByOtherWorktrees(
      {
        tabsByWorktree: {
          [SPAWN]: [{ id: 'tab-split', ptyId: null }]
        },
        ptyIdsByTabId: { 'tab-split': ['pty-leaf-a', 'pty-leaf-b'] }
      },
      OWN
    )

    expect(claimed).toEqual(new Set(['pty-leaf-a', 'pty-leaf-b']))
  })

  it('treats a path-respelled own worktree as its own', () => {
    const claimed = collectPtyIdsOwnedByOtherWorktrees(
      {
        tabsByWorktree: {
          [`${OWN}/`]: [{ id: 'tab-own', ptyId: 'pty-own' }]
        }
      },
      OWN
    )

    expect(claimed.size).toBe(0)
  })
})
