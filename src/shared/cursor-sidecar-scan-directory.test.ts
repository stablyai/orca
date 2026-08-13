import type { Dirent } from 'node:fs'
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  CURSOR_DIR_MAX_ENTRIES_EXAMINED,
  listLexicographicDirectoryNames,
  retainLexicographic,
  setStreamDirectoryIoForTests,
  streamDirectoryNames
} from './cursor-sidecar-scan-directory'

const tempRoots: string[] = []

afterEach(async () => {
  setStreamDirectoryIoForTests()
  await Promise.all(tempRoots.splice(0).map((root) => rm(root, { recursive: true, force: true })))
})

async function tempDir(prefix: string): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), prefix))
  tempRoots.push(root)
  return root
}

async function fillDirectory(dirPath: string, count: number, prefix = 'e'): Promise<string[]> {
  await mkdir(dirPath, { recursive: true })
  const names = Array.from(
    { length: count },
    (_, index) => `${prefix}-${String(index).padStart(5, '0')}`
  )
  await Promise.all(names.map((name) => writeFile(join(dirPath, name), '')))
  return names
}

function unsupportedDirectoryStreamError(): NodeJS.ErrnoException {
  return Object.assign(new Error('directory streams unavailable'), { code: 'ENOTSUP' })
}

describe('cursor sidecar directory examination bounds', () => {
  it('reports examinationTruncated=false when the directory fits the exact budget', async () => {
    const root = await tempDir('orca-cursor-dir-exact-')
    const budget = 32
    await fillDirectory(root, budget)

    const visited: string[] = []
    const result = await streamDirectoryNames(
      root,
      (name) => {
        visited.push(name)
      },
      { maxEntriesExamined: budget }
    )

    expect(result.entriesExamined).toBe(budget)
    expect(result.examinationTruncated).toBe(false)
    expect(visited).toHaveLength(budget)
  })

  it('uses a bounded overflow probe so budget+1 truthfully reports truncation', async () => {
    const root = await tempDir('orca-cursor-dir-overflow-')
    const budget = 32
    await fillDirectory(root, budget + 1)

    const visited: string[] = []
    let onDirentCount = 0
    const result = await streamDirectoryNames(
      root,
      (name) => {
        visited.push(name)
      },
      {
        maxEntriesExamined: budget,
        onDirent: () => {
          onDirentCount += 1
        }
      }
    )

    expect(result.entriesExamined).toBe(budget)
    expect(result.examinationTruncated).toBe(true)
    expect(visited).toHaveLength(budget)
    // Probe must not count as examination or fire onDirent.
    expect(onDirentCount).toBe(budget)
  })

  it('fails bounded when directory streaming is unsupported', async () => {
    const root = await tempDir('orca-cursor-dir-fallback-')
    const budget = 16
    await fillDirectory(root, budget + 8)

    setStreamDirectoryIoForTests({
      opendir: async () => {
        throw unsupportedDirectoryStreamError()
      }
    })

    const visited: string[] = []
    const result = await streamDirectoryNames(
      root,
      (name) => {
        visited.push(name)
      },
      { maxEntriesExamined: budget }
    )

    expect(result).toEqual({ entriesExamined: 0, examinationTruncated: true })
    expect(visited).toEqual([])
  })

  it('propagates cancellation from onDirent during examination', async () => {
    const root = await tempDir('orca-cursor-dir-cancel-')
    await fillDirectory(root, 64)
    let seen = 0
    await expect(
      streamDirectoryNames(root, () => undefined, {
        maxEntriesExamined: 64,
        onDirent: () => {
          seen += 1
          if (seen >= 10) {
            throw new Error('cursor_sidecar_scan_cancelled')
          }
        }
      })
    ).rejects.toThrow('cursor_sidecar_scan_cancelled')
    expect(seen).toBe(10)
  })

  it('keeps listLexicographic examination-truncated when the walk hits the budget with more left', async () => {
    const root = await tempDir('orca-cursor-dir-list-trunc-')
    await fillDirectory(root, 20, 'z')
    const listed = await listLexicographicDirectoryNames({
      dirPath: root,
      limit: 5,
      maxEntriesExamined: 10,
      accept: () => true
    })
    expect(listed.entriesExamined).toBe(10)
    expect(listed.truncated).toBe(true)
    expect(listed.names).toHaveLength(5)
  })

  it('does not mark truncated for an exact-budget complete directory with room in retention', async () => {
    const root = await tempDir('orca-cursor-dir-list-exact-')
    await fillDirectory(root, 10, 'a')
    const listed = await listLexicographicDirectoryNames({
      dirPath: root,
      limit: 20,
      maxEntriesExamined: 10,
      accept: () => true
    })
    expect(listed.entriesExamined).toBe(10)
    expect(listed.truncated).toBe(false)
    expect(listed.names).toHaveLength(10)
  })

  it('bounds a 10k-entry directory walk for time, examination, and retained selection', async () => {
    const root = await tempDir('orca-cursor-dir-10k-')
    const total = 10_000
    await fillDirectory(root, total)
    const budget = CURSOR_DIR_MAX_ENTRIES_EXAMINED
    expect(total).toBeGreaterThan(budget)

    const visited: string[] = []
    const started = Date.now()
    const result = await streamDirectoryNames(
      root,
      (name) => {
        visited.push(name)
      },
      { maxEntriesExamined: budget }
    )
    const elapsedMs = Date.now() - started

    expect(result.entriesExamined).toBe(budget)
    expect(result.examinationTruncated).toBe(true)
    expect(visited).toHaveLength(budget)
    // Adversarial cold walk must stay well under multi-second wall time on local SSDs.
    expect(elapsedMs).toBeLessThan(15_000)

    const listed = await listLexicographicDirectoryNames({
      dirPath: root,
      limit: 64,
      maxEntriesExamined: budget,
      accept: () => true
    })
    expect(listed.entriesExamined).toBe(budget)
    expect(listed.truncated).toBe(true)
    expect(listed.names).toHaveLength(64)
  }, 60_000)

  it('unsupported streaming does not traverse a 10k store', async () => {
    const root = await tempDir('orca-cursor-dir-10k-fallback-')
    await fillDirectory(root, 10_000)
    setStreamDirectoryIoForTests({
      opendir: async () => {
        throw unsupportedDirectoryStreamError()
      }
    })
    const budget = 128
    let visits = 0
    const result = await streamDirectoryNames(
      root,
      () => {
        visits += 1
      },
      { maxEntriesExamined: budget }
    )
    expect(visits).toBe(0)
    expect(result).toEqual({ entriesExamined: 0, examinationTruncated: true })
  }, 60_000)

  it('retainLexicographic keeps only the first `limit` names in order', () => {
    const selected: string[] = []
    expect(retainLexicographic(selected, 'm', 3)).toBe(false)
    expect(retainLexicographic(selected, 'a', 3)).toBe(false)
    expect(retainLexicographic(selected, 'z', 3)).toBe(false)
    expect(retainLexicographic(selected, 'b', 3)).toBe(true)
    expect(selected).toEqual(['a', 'b', 'm'])
  })

  it('retains the same Unicode name regardless of directory iteration order', () => {
    const composedFirst: string[] = []
    const decomposedFirst: string[] = []
    for (const name of ['\u00e9', 'e\u0301']) {
      retainLexicographic(composedFirst, name, 1)
    }
    for (const name of ['e\u0301', '\u00e9']) {
      retainLexicographic(decomposedFirst, name, 1)
    }

    expect(composedFirst).toEqual(['e\u0301'])
    expect(decomposedFirst).toEqual(['e\u0301'])
  })

  it('bounds reverse-ordered retention without locale collation', () => {
    const localeCompare = vi.spyOn(String.prototype, 'localeCompare')
    const selected: string[] = []

    try {
      for (let index = 255; index >= 0; index -= 1) {
        retainLexicographic(selected, String(index).padStart(3, '0'), 64)
      }
      expect(localeCompare).not.toHaveBeenCalled()
    } finally {
      localeCompare.mockRestore()
    }

    expect(selected).toEqual(
      Array.from({ length: 64 }, (_, index) => String(index).padStart(3, '0'))
    )
  })

  it('treats a zero examination budget as already truncated', async () => {
    const root = await tempDir('orca-cursor-dir-zero-')
    await fillDirectory(root, 3)
    const visit = vi.fn()
    const result = await streamDirectoryNames(root, visit, { maxEntriesExamined: 0 })
    expect(result).toEqual({ entriesExamined: 0, examinationTruncated: true })
    expect(visit).not.toHaveBeenCalled()
  })
})

describe('streamDirectoryNames Dirent typing for accept filters', () => {
  it('passes real Dirent instances so isDirectory predicates work', async () => {
    const root = await tempDir('orca-cursor-dir-types-')
    await mkdir(join(root, 'bucket'), { recursive: true })
    await writeFile(join(root, 'file.txt'), '')
    const kinds: string[] = []
    await streamDirectoryNames(root, (_name, entry: Dirent) => {
      kinds.push(
        entry.isDirectory()
          ? 'dir'
          : entry.isFile()
            ? 'file'
            : entry.isSymbolicLink()
              ? 'link'
              : 'other'
      )
    })
    expect(kinds.sort()).toEqual(['dir', 'file'])
  })
})
