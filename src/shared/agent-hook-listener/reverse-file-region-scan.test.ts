import { afterEach, describe, expect, it, vi } from 'vitest'
import { mkdtempSync, readSync, rmSync, writeFileSync } from 'node:fs'
import type * as NodeFs from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { scanFileRegionsBackward } from './reverse-file-region-scan'

vi.mock('node:fs', async (importOriginal) => {
  const fs = await importOriginal<typeof NodeFs>()
  return { ...fs, readSync: vi.fn(fs.readSync) }
})

const roots: string[] = []
afterEach(() => {
  for (const root of roots.splice(0)) {
    rmSync(root, { recursive: true, force: true })
  }
})

function writeFixture(contents: string): string {
  const root = mkdtempSync(join(tmpdir(), 'orca-reverse-scan-'))
  roots.push(root)
  const file = join(root, 'transcript.jsonl')
  writeFileSync(file, contents)
  return file
}

function collectLines(file: string, chunkBytes: number, maxScanBytes = 1024 * 1024): string[] {
  const seen: string[] = []
  scanFileRegionsBackward(file, { chunkBytes, maxScanBytes }, (region) => {
    seen.push(...region.toString('utf8').split('\n').filter(Boolean))
    return undefined
  })
  return seen
}

describe('scanFileRegionsBackward', () => {
  it('reports completion only after an available scan', () => {
    const file = writeFixture('first\nsecond\n')
    const completed = vi.fn()
    const limits = { chunkBytes: 8, maxScanBytes: 8 }
    vi.mocked(readSync).mockReturnValueOnce(0)
    expect(scanFileRegionsBackward(file, limits, () => undefined, completed)).toBeUndefined()
    expect(completed).not.toHaveBeenCalled()
    scanFileRegionsBackward(file, limits, () => undefined, completed)
    expect(completed).toHaveBeenCalledTimes(1)
  })

  it('yields every whole line exactly once, whatever the chunk size', () => {
    const lines = Array.from({ length: 40 }, (_, i) => `line-${i}`)
    const file = writeFixture(`${lines.join('\n')}\n`)
    for (const chunkBytes of [8, 16, 64, 4096]) {
      const regions: string[][] = []
      scanFileRegionsBackward(file, { chunkBytes, maxScanBytes: 1024 * 1024 }, (region) => {
        regions.push(region.toString('utf8').split('\n').filter(Boolean))
        return undefined
      })
      expect(regions.toReversed().flat()).toEqual(lines)
    }
  })

  it('stops at the first defined result without reading the rest of the file', () => {
    const file = writeFixture(`${Array.from({ length: 200 }, (_, i) => `line-${i}`).join('\n')}\n`)
    let regions = 0
    const found = scanFileRegionsBackward(
      file,
      { chunkBytes: 32, maxScanBytes: 1024 * 1024 },
      () => {
        regions += 1
        return 'first'
      }
    )
    expect(found).toBe('first')
    expect(regions).toBe(1)
  })

  it('reports the byte offset each region starts at', () => {
    const file = writeFixture('😀alpha\nbravo\ncharlie\n')
    const offsets: { text: string; regionPosition: number }[] = []
    scanFileRegionsBackward(
      file,
      { chunkBytes: 8, maxScanBytes: 4096 },
      (region, regionPosition) => {
        offsets.push({ text: region.toString('utf8'), regionPosition })
        return undefined
      }
    )
    expect(offsets).toEqual([
      { text: 'bravo\ncharlie', regionPosition: 10 },
      { text: '😀alpha', regionPosition: 0 }
    ])
  })

  it('drops the leading partial line when it stops on the byte budget', () => {
    // A byte cap cannot prove the start of the topmost record.
    const file = writeFixture(`${'x'.repeat(500)}\nkeep-me\n`)
    expect(collectLines(file, 64, 128)).toEqual(['keep-me'])
  })
})
