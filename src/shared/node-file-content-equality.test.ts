import { mkdtempSync, rmSync, truncateSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { nodeFileContentsEqual, nodeFileContentsEqualSync } from './node-file-content-equality'

const roots: string[] = []

function createFile(contents: string): string {
  const root = mkdtempSync(join(tmpdir(), 'orca-file-content-equality-'))
  roots.push(root)
  const filePath = join(root, 'owned-launcher')
  writeFileSync(filePath, contents)
  return filePath
}

afterEach(() => {
  for (const root of roots.splice(0)) {
    rmSync(root, { recursive: true, force: true })
  }
})

describe('Node file content equality', () => {
  it('compares UTF-8 content without changing its bytes', async () => {
    const filePath = createFile('launch 🐋\n')

    await expect(nodeFileContentsEqual(filePath, 'launch 🐋\n')).resolves.toBe(true)
    expect(nodeFileContentsEqualSync(filePath, 'launch 🐋\n')).toBe(true)
    await expect(nodeFileContentsEqual(filePath, 'different\n')).resolves.toBe(false)
    expect(nodeFileContentsEqualSync(filePath, 'different\n')).toBe(false)
  })

  it('rejects a large sparse replacement from metadata without reading its payload', async () => {
    const filePath = createFile('owned launcher\n')
    truncateSync(filePath, 256 * 1024 * 1024)

    await expect(nodeFileContentsEqual(filePath, 'owned launcher\n')).resolves.toBe(false)
    expect(nodeFileContentsEqualSync(filePath, 'owned launcher\n')).toBe(false)
  })
})
