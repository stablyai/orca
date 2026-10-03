import { closeSync, ftruncateSync, mkdtempSync, openSync, rmSync, writeFileSync } from 'node:fs'
import * as fs from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { NodeFileReadTooLargeError, readNodeFileSyncWithinLimit } from './node-bounded-file-reader'

vi.mock('node:fs', async (importOriginal) => ({
  ...(await importOriginal<typeof fs>())
}))

const tempDirectories: string[] = []

function createTempFile(content: string): string {
  const directory = mkdtempSync(join(tmpdir(), 'orca-bounded-sync-read-'))
  tempDirectories.push(directory)
  const path = join(directory, 'input')
  writeFileSync(path, content)
  return path
}

afterEach(() => {
  vi.restoreAllMocks()
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

describe('regular file growth evidence', () => {
  it('refuses growth beyond the byte limit during a read', () => {
    const path = createTempFile('abcd')
    const original = fs.readSync
    const spy = vi.spyOn(fs, 'readSync').mockImplementation((...args) => {
      const bytes = original(...args)
      if (spy.mock.calls.length === 1) {
        fs.appendFileSync(path, 'x'.repeat(1024))
      }
      return bytes
    })
    expect(() => readNodeFileSyncWithinLimit(path, 1024, { regularFileOnly: true })).toThrow(
      NodeFileReadTooLargeError
    )
  })

  it('validates the opened descriptor when the path evidence changes', () => {
    const path = createTempFile('abcd')
    const original = fs.statSync
    vi.spyOn(fs, 'statSync').mockImplementation((...args) => {
      const evidence = original(...args)
      fs.unlinkSync(path)
      fs.mkdirSync(path)
      return evidence
    })
    expect(() => readNodeFileSyncWithinLimit(path, 1024, { regularFileOnly: true })).toThrow(
      'Expected a regular file'
    )
  })
})
