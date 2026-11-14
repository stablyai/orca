import { expect, it } from 'vitest'
import {
  encodeBrowserExtensionWireJson,
  decodeBrowserExtensionWireJson
} from './browser-extension-worker-api'

it('round-trips binary session values without confusing extension strings with wire tags', () => {
  const value = {
    binary: new Uint8Array([0, 128, 255]),
    literal: '\u0000binary:AA==',
    undefinedValue: undefined
  }
  // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: The fixture round-trips this exact object and binary payload through the wire codec.
  const decoded = decodeBrowserExtensionWireJson(encodeBrowserExtensionWireJson(value)) as Record<
    string,
    unknown
  >
  // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: The fixture round-trips this exact object and binary payload through the wire codec.
  expect([...new Uint8Array(decoded.binary as ArrayBuffer)]).toEqual([0, 128, 255])
  expect(decoded.literal).toBe('\u0000binary:AA==')
  expect(decoded.undefinedValue).toBeUndefined()
})
