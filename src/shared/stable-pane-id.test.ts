import { describe, expect, it } from 'vitest'
import {
  isStablePaneId,
  isTerminalLeafId,
  makePaneKey,
  parseLegacyNumericPaneKey,
  parsePaneKey
} from './stable-pane-id'

const LEAF_ID = '11111111-1111-4111-8111-111111111111'

describe('stable pane ids', () => {
  it('recognizes UUID leaf ids as stable pane ids', () => {
    expect(isStablePaneId(LEAF_ID)).toBe(true)
    expect(isTerminalLeafId(LEAF_ID)).toBe(true)
  })

  it('rejects legacy numeric pane ids and malformed UUIDs', () => {
    for (const value of ['1', 'pane:1', '11111111-1111-6111-8111-111111111111', '']) {
      expect(isStablePaneId(value)).toBe(false)
      expect(isTerminalLeafId(value)).toBe(false)
    }
  })

  it('builds and parses pane keys using the tab id and UUID leaf id', () => {
    const paneKey = makePaneKey('tab-1', LEAF_ID)

    expect(paneKey).toBe(`tab-1:${LEAF_ID}`)
    expect(parsePaneKey(paneKey)).toEqual({
      tabId: 'tab-1',
      leafId: LEAF_ID,
      stablePaneId: LEAF_ID
    })
  })

  it('rejects ambiguous tab ids and non-UUID leaf ids when building keys', () => {
    expect(() => makePaneKey('', LEAF_ID)).toThrow(/tabId/)
    expect(() => makePaneKey('tab:1', LEAF_ID)).toThrow(/tabId/)
    expect(() => makePaneKey('tab-1', '1')).toThrow(/UUID/)
  })

  it('rejects ambiguous or legacy pane-key inputs when parsing', () => {
    expect(parsePaneKey('tab-1:1')).toBeNull()
    expect(parsePaneKey(`tab:1:${LEAF_ID}`)).toBeNull()
    expect(parsePaneKey(`:${LEAF_ID}`)).toBeNull()
    expect(parsePaneKey('tab-1:')).toBeNull()
  })

  it('parses legacy numeric pane keys only for migration aliases', () => {
    expect(parseLegacyNumericPaneKey(' tab-1:12 ')).toEqual({
      tabId: 'tab-1',
      numericPaneId: '12',
      paneKey: 'tab-1:12'
    })
    expect(parseLegacyNumericPaneKey(`tab-1:${LEAF_ID}`)).toBeNull()
    expect(parseLegacyNumericPaneKey('tab:1:12')).toBeNull()
  })
})
