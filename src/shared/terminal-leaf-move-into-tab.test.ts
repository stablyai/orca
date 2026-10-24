import { describe, expect, it } from 'vitest'
import {
  isTerminalLeafIntoTabRequest,
  terminalLeafMovePaneKeys,
  type TerminalLeafIntoTabRequest
} from './terminal-leaf-move'

const LEAF = '22222222-2222-4222-8222-222222222222'
const TARGET_LEAF = '11111111-1111-4111-8111-111111111111'
const valid: TerminalLeafIntoTabRequest = {
  worktreeId: 'repo-1::/tmp/wt',
  sourceTabId: 'tab-source',
  targetTabId: 'tab-target',
  targetLeafId: TARGET_LEAF,
  leafId: LEAF,
  ptyId: null,
  placement: { kind: 'beside', side: 'right' }
}

describe('isTerminalLeafIntoTabRequest', () => {
  it('accepts a join beside a leaf of another tab on every side', () => {
    for (const side of ['left', 'right', 'top', 'bottom'] as const) {
      expect(isTerminalLeafIntoTabRequest({ ...valid, placement: { kind: 'beside', side } })).toBe(
        true
      )
    }
    expect(isTerminalLeafIntoTabRequest({ ...valid, ptyId: 'pty-1' })).toBe(true)
  })

  it.each([
    ['the same tab', { targetTabId: 'tab-source' }],
    ['the moved leaf as its own target', { targetLeafId: LEAF }],
    ['a legacy numeric moved leaf id', { leafId: '2' }],
    ['a legacy numeric target leaf id', { targetLeafId: '1' }],
    ['a source tab id that would split a pane key', { sourceTabId: 'tab:source' }],
    ['a target tab id that would split a pane key', { targetTabId: 'tab:target' }],
    ['an empty PTY id', { ptyId: '' }],
    ['a missing placement', { placement: undefined }],
    ['a placement kind other than beside', { placement: { kind: 'swap' } }],
    ['an unknown side', { placement: { kind: 'beside', side: 'center' } }]
  ])('rejects %s', (_name, patch) => {
    expect(isTerminalLeafIntoTabRequest({ ...valid, ...patch })).toBe(false)
  })

  it('rejects non-objects', () => {
    expect(isTerminalLeafIntoTabRequest(null)).toBe(false)
    expect(isTerminalLeafIntoTabRequest('move')).toBe(false)
  })

  it('names the moved pane key before and after, from the same helper as a detach', () => {
    expect(terminalLeafMovePaneKeys(valid)).toEqual({
      from: `tab-source:${LEAF}`,
      to: `tab-target:${LEAF}`
    })
  })
})
