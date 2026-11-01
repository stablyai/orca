import { describe, expect, it } from 'vitest'
import { makePaneKey, parseLegacyNumericPaneKey, parsePaneKey } from './stable-pane-id'

const LEAF_ID = '11111111-1111-4111-8111-111111111111'

describe('stable pane ids', () => {
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
