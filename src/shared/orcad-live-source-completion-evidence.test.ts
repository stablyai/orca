import { expect, it } from 'vitest'
import { parseOrcadLiveSourceCompletionEvidence } from './orcad-live-source-completion-evidence'

const evidence = {
  version: 1,
  retirementRecordSha256: 'a'.repeat(64),
  sourceRouteCheckpointSha256: 'b'.repeat(64)
}

it('parses minimal evidence without adding authority or state fields', () => {
  expect(parseOrcadLiveSourceCompletionEvidence(evidence)).toEqual(evidence)
})

it.each([undefined, null, [], {}, { ...evidence, version: 2 }])(
  'rejects malformed evidence %j',
  (value) => {
    expect(() => parseOrcadLiveSourceCompletionEvidence(value)).toThrow()
  }
)

it.each(['retirementRecordSha256', 'sourceRouteCheckpointSha256'] as const)(
  'requires a canonical SHA-256 in %s',
  (field) => {
    for (const value of [
      undefined,
      '',
      'a'.repeat(63),
      'a'.repeat(65),
      'A'.repeat(64),
      'g'.repeat(64),
      1
    ]) {
      expect(() =>
        parseOrcadLiveSourceCompletionEvidence({ ...evidence, [field]: value })
      ).toThrow()
    }
  }
)
