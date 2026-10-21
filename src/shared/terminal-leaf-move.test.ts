import { describe, expect, it } from 'vitest'
import { isTerminalLeafMoveRequest, terminalLeafMovePaneKeys } from './terminal-leaf-move'

const LEAF = '22222222-2222-4222-8222-222222222222'
const valid = {
  worktreeId: 'repo-1::/tmp/wt',
  sourceTabId: 'tab-source',
  targetTabId: 'tab-target',
  leafId: LEAF,
  ptyId: null
}

describe('isTerminalLeafMoveRequest', () => {
  it('accepts a move between two tabs with a stable leaf id', () => {
    expect(isTerminalLeafMoveRequest(valid)).toBe(true)
    expect(isTerminalLeafMoveRequest({ ...valid, ptyId: 'pty-1' })).toBe(true)
  })

  it.each([
    ['the same tab', { targetTabId: 'tab-source' }],
    ['a legacy numeric leaf id', { leafId: '2' }],
    ['a source tab id that would split a pane key', { sourceTabId: 'tab:source' }],
    ['a target tab id that would split a pane key', { targetTabId: 'tab:target' }],
    ['an empty PTY id', { ptyId: '' }]
  ])('rejects %s', (_name, patch) => {
    expect(isTerminalLeafMoveRequest({ ...valid, ...patch })).toBe(false)
  })

  it('builds both pane keys of a valid move', () => {
    expect(terminalLeafMovePaneKeys(valid)).toEqual({
      from: `tab-source:${LEAF}`,
      to: `tab-target:${LEAF}`
    })
  })
})
