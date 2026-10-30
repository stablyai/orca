import { describe, expect, it } from 'vitest'
import { getWorktreeStatus } from './worktree-status'

const LEAF_A = '11111111-1111-4111-8111-111111111111'
const LEAF_C = '33333333-3333-4333-8333-333333333333'

describe('live numeric slots after closing an earlier split pane', () => {
  it('keeps a working background pane whose runtime id exceeds the remaining leaf count', () => {
    expect(
      getWorktreeStatus(
        [{ id: 'tab', title: 'zsh', launchAgent: 'codex' }],
        [],
        { tab: ['pty-a', 'pty-c'] },
        { tab: { 1: 'zsh', 3: '⠋ Codex' } },
        {
          terminalLayoutRootsByTabId: {
            tab: {
              type: 'split',
              direction: 'horizontal',
              first: { type: 'leaf', leafId: LEAF_A },
              second: { type: 'leaf', leafId: LEAF_C }
            }
          }
        }
      )
    ).toBe('working')
  })
})

describe('pane titles from removed panes', () => {
  it('ignores a removed durable leaf spinner and falls back to the idle tab title', () => {
    const removedLeafTitles = { [LEAF_C]: '⠋ Codex' }
    expect(
      getWorktreeStatus(
        [{ id: 'tab', title: 'zsh', launchAgent: 'codex' }],
        [],
        { tab: ['pty-a'] },
        { tab: removedLeafTitles },
        { terminalLayoutRootsByTabId: { tab: { type: 'leaf', leafId: LEAF_A } } }
      )
    ).not.toBe('working')
  })
})
