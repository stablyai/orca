import { mkdtempSync, rmSync, truncateSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { NodeFileReadTooLargeError } from './node-bounded-file-reader'
import { RELAY_VERSION_MARKER_MAX_BYTES, readRelayVersionMarkerSync } from './relay-version-marker'

const roots: string[] = []

function createVersionFile(contents: string): string {
  const root = mkdtempSync(join(tmpdir(), 'orca-relay-version-marker-'))
  roots.push(root)
  const filePath = join(root, '.version')
  writeFileSync(filePath, contents)
  return filePath
}

afterEach(() => {
  for (const root of roots.splice(0)) {
    rmSync(root, { recursive: true, force: true })
  }
})

describe('relay version marker', () => {
  it('accepts a trimmed marker at the exact byte boundary', () => {
    const version = '1.2.3+deadbeef'
    const filePath = createVersionFile(
      version + ' '.repeat(RELAY_VERSION_MARKER_MAX_BYTES - Buffer.byteLength(version))
    )

    expect(readRelayVersionMarkerSync(filePath)).toBe(version)
  })

  it('rejects a sparse marker one byte over the boundary', () => {
    const filePath = createVersionFile('1.2.3')
    truncateSync(filePath, RELAY_VERSION_MARKER_MAX_BYTES + 1)

    expect(() => readRelayVersionMarkerSync(filePath)).toThrow(NodeFileReadTooLargeError)
  })
})
