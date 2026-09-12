import { expect, it } from 'vitest'
import { parseOrcadLiveRetirementMarkers } from './orcad-live-retirement-marker'

const marker = {
  version: 1,
  migrationId: 'migration',
  recordSha256: 'a'.repeat(64),
  installedAt: '2026-09-07T00:00:00.000Z'
}
it('accepts absent legacy evidence and preserves exact valid markers', () => {
  expect(parseOrcadLiveRetirementMarkers(undefined)).toEqual([])
  expect(parseOrcadLiveRetirementMarkers([marker])).toEqual([marker])
})
it.each([
  null,
  {},
  [null],
  [{ ...marker, version: 2 }],
  [{ ...marker, recordSha256: 'bad' }],
  [{ ...marker, installedAt: 'bad' }],
  [marker, marker],
  Array.from({ length: 5 }, (_, index) => ({ ...marker, migrationId: String(index) }))
])('refuses malformed completion evidence without dropping it: %j', (value) => {
  expect(() => parseOrcadLiveRetirementMarkers(value)).toThrow()
})
