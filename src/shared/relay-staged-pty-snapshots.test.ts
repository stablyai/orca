import { describe, expect, it } from 'vitest'
import { decodeRelayStagedPtySnapshots } from './relay-staged-pty-snapshots'

function v2Entry(index: number) {
  const data = `tail-${index}`
  return {
    id: `pty-${index}`,
    paneKey: `tab-${index}:11111111-1111-4111-8111-${String(index).padStart(12, '0')}`,
    sourceIncarnationId: `incarnation-${index}`,
    replayTail: { data, encoding: 'utf8', byteLength: data.length, truncated: false }
  }
}

describe('decodeRelayStagedPtySnapshots', () => {
  it('accepts exactly the relay 50-entry limit without dropping a pane tail', () => {
    const entries = Array.from({ length: 50 }, (_, index) => v2Entry(index))
    const decoded = decodeRelayStagedPtySnapshots(JSON.stringify({ schemaVersion: 2, entries }))

    expect(decoded.kind).toBe('v2')
    expect(decoded.snapshotsByPaneKey.size).toBe(50)
    expect(decoded.snapshotsByPaneKey.get(entries[49]!.paneKey)?.replayTail?.data).toBe('tail-49')
  })

  it('fails closed instead of truncating a 51-entry staged envelope', () => {
    const entries = Array.from({ length: 51 }, (_, index) => v2Entry(index))
    const decoded = decodeRelayStagedPtySnapshots(JSON.stringify({ schemaVersion: 2, entries }))

    expect(decoded).toMatchObject({ kind: 'invalid' })
    expect(decoded.snapshotsByPaneKey.size).toBe(0)
  })

  it('fails the entire envelope when one entry is malformed', () => {
    const valid = v2Entry(1)
    const decoded = decodeRelayStagedPtySnapshots(
      JSON.stringify({
        schemaVersion: 2,
        entries: [valid, { ...v2Entry(2), sourceIncarnationId: null }]
      })
    )

    expect(decoded).toMatchObject({ kind: 'invalid' })
    expect(decoded.snapshotsByPaneKey.size).toBe(0)
  })

  it('distinguishes the legacy array envelope from a missing staged state', () => {
    expect(decodeRelayStagedPtySnapshots(JSON.stringify([v2Entry(1)]))).toMatchObject({
      kind: 'legacy'
    })
    expect(decodeRelayStagedPtySnapshots(null)).toMatchObject({ kind: 'missing' })
  })
})
