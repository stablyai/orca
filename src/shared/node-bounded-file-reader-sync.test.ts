import { closeSync, ftruncateSync, mkdtempSync, openSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { NodeFileReadTooLargeError, readNodeFileSyncWithinLimit } from './node-bounded-file-reader'

const tempDirectories: string[] = []

function createTempFile(content: string): string {
  const directory = mkdtempSync(join(tmpdir(), 'orca-bounded-sync-read-'))
  tempDirectories.push(directory)
  const path = join(directory, 'input')
  writeFileSync(path, content)
  return path
}

afterEach(() => {
  for (const directory of tempDirectories.splice(0)) {
    rmSync(directory, { recursive: true })
  }
})

describe('readNodeFileSyncWithinLimit', () => {
  it('returns stable bytes without changing them', () => {
    const path = createTempFile('stable 🐋 bytes')

    expect(readNodeFileSyncWithinLimit(path, 1024).buffer.toString('utf8')).toBe('stable 🐋 bytes')
  })

  it('rejects an oversized sparse file before allocating its declared size', () => {
    const path = createTempFile('')
    const descriptor = openSync(path, 'r+')
    ftruncateSync(descriptor, 1025)
    closeSync(descriptor)

    expect(() => readNodeFileSyncWithinLimit(path, 1024)).toThrow(NodeFileReadTooLargeError)
  })
})
