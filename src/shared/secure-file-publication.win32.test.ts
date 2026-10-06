import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { writeProtectedFileAtomic } from './secure-file-publication'
import { restrictWindowsPath } from './secure-path-windows-acl'

describe.skipIf(process.platform !== 'win32')('native Windows protected publication', () => {
  it('creates nested protected directories under the native TEMP spelling, including 8.3 paths', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'orca-protected-native-'))
    const path = join(directory, 'scope', 'nested', 'vault')
    const operation = { deadline: Date.now() + 15_000, signal: new AbortController().signal }
    try {
      await writeProtectedFileAtomic(path, Buffer.from('public-test-envelope'), operation)
      expect(await readFile(path, 'utf8')).toBe('public-test-envelope')
      expect(await restrictWindowsPath(path, false, operation)).toBe(true)
    } finally {
      await rm(directory, { recursive: true, force: true })
    }
  }, 20_000)
})
