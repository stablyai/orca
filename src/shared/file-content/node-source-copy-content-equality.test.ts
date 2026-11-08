import {
  closeSync,
  mkdtempSync,
  openSync,
  rmSync,
  truncateSync,
  writeFileSync,
  writeSync
} from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import {
  NODE_FILE_CONTENT_COMPARE_CHUNK_BYTES,
  nodeSourceAndCopyContentsEqualSync
} from './node-source-copy-content-equality'

describe('Node source/copy content equality', () => {
  const roots: string[] = []

  afterEach(() => {
    for (const root of roots.splice(0)) {
      rmSync(root, { recursive: true, force: true })
    }
  })

  it('compares multi-megabyte sparse files with fixed-size chunks', () => {
    const root = mkdtempSync(join(tmpdir(), 'orca-resource-compare-'))
    roots.push(root)
    const sourcePath = join(root, 'source.md')
    const copyPath = join(root, 'copy.md')
    const sparseBytes = NODE_FILE_CONTENT_COMPARE_CHUNK_BYTES * 128
    for (const path of [sourcePath, copyPath]) {
      writeFileSync(path, 'same-prefix')
      truncateSync(path, sparseBytes)
    }

    expect(nodeSourceAndCopyContentsEqualSync(sourcePath, copyPath)).toBe(true)

    const descriptor = openSync(copyPath, 'r+')
    try {
      writeSync(descriptor, Buffer.from('x'), 0, 1, sparseBytes - 1)
    } finally {
      closeSync(descriptor)
    }
    expect(nodeSourceAndCopyContentsEqualSync(sourcePath, copyPath)).toBe(false)
  })

  it('rejects a non-file copy without attempting to consume it', () => {
    const root = mkdtempSync(join(tmpdir(), 'orca-resource-compare-dir-'))
    roots.push(root)
    const sourcePath = join(root, 'source.md')
    writeFileSync(sourcePath, 'contents')

    expect(nodeSourceAndCopyContentsEqualSync(sourcePath, root)).toBe(false)
  })
})
