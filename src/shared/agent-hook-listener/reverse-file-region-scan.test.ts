import { afterEach, describe, expect, it } from 'vitest'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { scanFileRegionsBackward } from './reverse-file-region-scan'

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

/** Every whole line the scan handed out, in the order the caller saw them. */
function collectLines(file: string, chunkBytes: number, maxScanBytes = 1024 * 1024): string[] {
  const seen: string[] = []
  scanFileRegionsBackward(file, { chunkBytes, maxScanBytes }, (region) => {
    seen.push(...region.toString('utf8').split('\n').filter(Boolean))
    return undefined
  })
  return seen
}

describe('scanFileRegionsBackward', () => {
  it('yields every whole line exactly once, whatever the chunk size', () => {
    const lines = Array.from({ length: 40 }, (_, i) => `line-${i}`)
    const file = writeFixture(`${lines.join('\n')}\n`)
    for (const chunkBytes of [8, 16, 64, 4096]) {
      // Why sorted: the scan walks backwards, so the caller sees later lines first.
      expect([...collectLines(file, chunkBytes)].sort()).toEqual([...lines].sort())
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
    const file = writeFixture('alpha\nbravo\ncharlie\n')
    const offsets = scanFileRegionsBackward(
      file,
      { chunkBytes: 4096, maxScanBytes: 4096 },
      (region, regionPosition) => ({ text: region.toString('utf8'), regionPosition })
    )
    expect(offsets).toEqual({ text: 'alpha\nbravo\ncharlie\n', regionPosition: 0 })
  })

  it('drops the leading partial line when it stops on the byte budget', () => {
    // Why: a scan capped mid-file has not seen the start of its topmost line, so
    // emitting it would hand the caller a truncated record.
    const file = writeFixture(`${'x'.repeat(500)}\nkeep-me\n`)
    expect(collectLines(file, 64, 128)).toEqual(['keep-me'])
  })

  it('reads a file with no trailing newline', () => {
    expect(collectLines(writeFixture('alpha\nbravo'), 4)).toContain('bravo')
  })

  it('treats an empty, missing, or unreadable file as nothing found', () => {
    expect(collectLines(writeFixture(''), 64)).toEqual([])
    expect(
      scanFileRegionsBackward(
        '/nonexistent/transcript.jsonl',
        {
          chunkBytes: 64,
          maxScanBytes: 64
        },
        () => 'x'
      )
    ).toBeUndefined()
  })
})
