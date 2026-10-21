import { describe, expect, it } from 'vitest'
import { parseTerminalPanePlacement } from './terminal-pane-placement'

const LEAF = '11111111-1111-4111-8111-111111111111'
const OTHER_LEAF = '22222222-2222-4222-8222-222222222222'

describe('parseTerminalPanePlacement', () => {
  it('accepts each kind', () => {
    const split = { kind: 'split', parentLeafId: LEAF, direction: 'vertical' }
    expect(parseTerminalPanePlacement({ kind: 'new-tab' })).toEqual({ kind: 'new-tab' })
    expect(parseTerminalPanePlacement(split)).toEqual(split)
    expect(parseTerminalPanePlacement({ kind: 'root' })).toEqual({ kind: 'root' })
  })

  it('keeps a new tab row and a split ratio and proposed tree', () => {
    const newTab = {
      kind: 'new-tab',
      row: {
        title: 'Terminal 2',
        customTitle: null,
        color: '#f97316',
        createdAt: 1,
        viewMode: 'chat'
      }
    }
    const split = {
      kind: 'split',
      parentLeafId: LEAF,
      direction: 'horizontal',
      ratio: 0.3,
      proposedRoot: {
        type: 'split',
        direction: 'horizontal',
        first: { type: 'leaf', leafId: OTHER_LEAF },
        second: { type: 'leaf', leafId: LEAF },
        ratio: 0.3
      }
    }
    expect(parseTerminalPanePlacement(newTab)).toEqual(newTab)
    expect(parseTerminalPanePlacement(split)).toEqual(split)
  })

  it('drops only a malformed optional field', () => {
    expect(parseTerminalPanePlacement({ kind: 'new-tab', row: { createdAt: 'now' } })).toEqual({
      kind: 'new-tab'
    })
    expect(
      parseTerminalPanePlacement({
        kind: 'split',
        parentLeafId: LEAF,
        direction: 'vertical',
        ratio: 'half',
        proposedRoot: { type: 'tree' }
      })
    ).toEqual({ kind: 'split', parentLeafId: LEAF, direction: 'vertical' })
  })

  it('strips fields a newer sender adds', () => {
    expect(parseTerminalPanePlacement({ kind: 'root', future: 1 })).toEqual({ kind: 'root' })
    expect(parseTerminalPanePlacement({ kind: 'new-tab', size: { cols: 120, rows: 40 } })).toEqual({
      kind: 'new-tab'
    })
  })

  it.each([
    ['absent', undefined],
    ['a future kind', { kind: 'floating' }],
    ['a legacy parent leaf id', { kind: 'split', parentLeafId: 'pane-1', direction: 'vertical' }],
    ['a bad direction', { kind: 'split', parentLeafId: LEAF, direction: 'diagonal' }],
    ['a split without direction', { kind: 'split', parentLeafId: LEAF }]
  ])('rejects %s', (_name, value) => {
    expect(parseTerminalPanePlacement(value)).toBeNull()
  })
})
