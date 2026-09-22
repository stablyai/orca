import type * as NodeFs from 'node:fs'
import {
  closeSync,
  mkdtempSync,
  openSync,
  readSync,
  rmSync,
  truncateSync,
  writeFileSync
} from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { nodeFilesEqualSync } from './node-file-content-equality'

vi.mock('node:fs', async (importOriginal) => {
  const actual = await importOriginal<typeof NodeFs>()
  return {
    ...actual,
    openSync: vi.fn(actual.openSync),
    readSync: vi.fn(actual.readSync),
    closeSync: vi.fn(actual.closeSync)
  }
})

let root: string

beforeEach(() => {
  vi.clearAllMocks()
  root = mkdtempSync(join(tmpdir(), 'orca-file-pair-equality-'))
})

afterEach(() => {
  rmSync(root, { recursive: true, force: true })
})

function createFile(name: string, contents = ''): string {
  const filePath = join(root, name)
  writeFileSync(filePath, contents)
  return filePath
}

function expectDescriptorsClosed(): void {
  const opened = vi
    .mocked(openSync)
    .mock.results.flatMap((result) => (result.type === 'return' ? [result.value] : []))
  expect(
    vi
      .mocked(closeSync)
      .mock.calls.map(([descriptor]) => descriptor)
      .sort()
  ).toEqual(opened.sort())
}

describe('Node file pair equality', () => {
  it('compares large sparse files with bounded read buffers', () => {
    const left = createFile('left')
    const right = createFile('right')
    truncateSync(left, 16 * 1024 * 1024)
    truncateSync(right, 16 * 1024 * 1024)

    expect(nodeFilesEqualSync(left, right)).toBe(true)
    expect(readSync).toHaveBeenCalled()
    expect(
      vi.mocked(readSync).mock.calls.every(([, buffer]) => buffer.byteLength <= 64 * 1024)
    ).toBe(true)
    expectDescriptorsClosed()
  })

  it.each([
    ['', '', true],
    ['short', 'longer', false],
    [`${'a'.repeat(65_536)}x`, `${'a'.repeat(65_536)}y`, false]
  ])('compares payloads including empty files and later differences', (left, right, equal) => {
    expect(nodeFilesEqualSync(createFile('left', left), createFile('right', right))).toBe(equal)
    expectDescriptorsClosed()
  })

  it('closes the first descriptor if the second file cannot open', () => {
    expect(() => nodeFilesEqualSync(createFile('left'), join(root, 'absent'))).toThrow()
    expectDescriptorsClosed()
  })

  it('closes both descriptors if a read fails', () => {
    vi.mocked(readSync).mockImplementationOnce(() => {
      throw new Error('read failed')
    })

    expect(() => nodeFilesEqualSync(createFile('left', 'a'), createFile('right', 'a'))).toThrow(
      'read failed'
    )
    expectDescriptorsClosed()
  })
})
