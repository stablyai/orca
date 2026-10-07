import { describe, expect, it } from 'vitest'
import { parseTerminalPanePlacement } from './terminal-pane-placement'

const LEAF = '11111111-1111-4111-8111-111111111111'

describe('parseTerminalPanePlacement', () => {
  it('accepts each kind', () => {
    const split = { kind: 'split', parentLeafId: LEAF, direction: 'vertical' }
    expect(parseTerminalPanePlacement({ kind: 'new-tab' })).toEqual({ kind: 'new-tab' })
    expect(parseTerminalPanePlacement(split)).toEqual(split)
    expect(parseTerminalPanePlacement({ kind: 'root' })).toEqual({ kind: 'root' })
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
