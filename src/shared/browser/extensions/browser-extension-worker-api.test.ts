import { describe, expect, it } from 'vitest'
import {
  decodeBrowserExtensionWireJson,
  encodeBrowserExtensionWireJson
} from './browser-extension-worker-api'

const roundTrip = (value: unknown): unknown =>
  decodeBrowserExtensionWireJson(encodeBrowserExtensionWireJson(value))

describe('browser extension wire JSON', () => {
  it('keeps undefined tuple slots and every extension string, including marker-like ones', () => {
    const args = [undefined, { kept: 1 }]
    const items = {
      legacyMarker: '__orcaUndefined__',
      escape: '\u0000',
      escaped: '\u0000\u0000x',
      list: ['__orcaUndefined__', '\u0000', 'plain']
    }
    expect(roundTrip(args)).toEqual([undefined, { kept: 1 }])
    expect(roundTrip(items)).toStrictEqual(items)
  })
})
