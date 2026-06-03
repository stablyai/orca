import { mkdtempSync, readFileSync, rmSync, statSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { writeUtf8FileInChunks, writeUtf8FileInChunksSync } from './utf8-file-writer'

let tempDirs: string[] = []

afterEach(() => {
  for (const dir of tempDirs) {
    rmSync(dir, { recursive: true, force: true })
  }
  tempDirs = []
})

function getTempFile(name: string): string {
  const dir = mkdtempSync(join(tmpdir(), 'orca-utf8-file-writer-'))
  tempDirs.push(dir)
  return join(dir, name)
}

function buildLargeJson(): string {
  return JSON.stringify({
    schemaVersion: 1,
    events: Array.from({ length: 2000 }, (_, index) => ({
      type: index % 2 === 0 ? 'agent_start' : 'agent_stop',
      at: 1760000000000 + index,
      meta: {
        ptyId: `pty-${index}`,
        note: 'plain stats payload '.repeat(8)
      }
    })),
    aggregates: {
      totalAgentsSpawned: 1000,
      totalPRsCreated: 0,
      totalAgentTimeMs: 0,
      countedPRs: [],
      firstEventAt: 1760000000000
    }
  })
}

function buildBoundaryJson(): string {
  const boundaryAstral = `${'a'.repeat(16_383)}😀${'b'.repeat(512)}`
  return JSON.stringify({
    note: `${boundaryAstral}${'é漢字'.repeat(20_000)}`
  })
}

function buildSparseNonAsciiChunk(): string {
  return `${'a'.repeat(8_192)}ç${'a'.repeat(16_383 - 8_192)}`
}

describe('writeUtf8FileInChunksSync', () => {
  it('writes large JSON byte-identically', () => {
    const json = buildLargeJson()
    const file = getTempFile('large.json')

    expect(Buffer.byteLength(json, 'utf8')).toBeGreaterThan(200_000)
    writeUtf8FileInChunksSync(file, json)

    expect(readFileSync(file)).toEqual(Buffer.from(json, 'utf8'))
  })

  it('preserves multibyte content and surrogate pairs at chunk boundaries', () => {
    const json = buildBoundaryJson()
    const file = getTempFile('multibyte.json')

    writeUtf8FileInChunksSync(file, json)

    expect(readFileSync(file)).toEqual(Buffer.from(json, 'utf8'))
  })

  it('preserves sparse non-ASCII content that Electron Buffer.from can mis-encode', () => {
    const contents = buildSparseNonAsciiChunk()
    const file = getTempFile('sparse-non-ascii.txt')

    expect(contents).toHaveLength(16_384)
    writeUtf8FileInChunksSync(file, contents)

    expect(readFileSync(file)).toEqual(Buffer.from(contents, 'utf8'))
  })

  it('honors private file modes', () => {
    if (process.platform === 'win32') {
      return
    }
    const file = getTempFile('private.json')

    writeUtf8FileInChunksSync(file, '{}', { mode: 0o600 })

    expect(statSync(file).mode & 0o777).toBe(0o600)
  })
})

describe('writeUtf8FileInChunks', () => {
  it('writes large JSON byte-identically', async () => {
    const json = buildLargeJson()
    const file = getTempFile('large-async.json')

    await writeUtf8FileInChunks(file, json)

    expect(readFileSync(file)).toEqual(Buffer.from(json, 'utf8'))
  })

  it('preserves multibyte content and surrogate pairs at chunk boundaries', async () => {
    const json = buildBoundaryJson()
    const file = getTempFile('multibyte-async.json')

    await writeUtf8FileInChunks(file, json)

    expect(readFileSync(file)).toEqual(Buffer.from(json, 'utf8'))
  })

  it('preserves sparse non-ASCII content that Electron Buffer.from can mis-encode', async () => {
    const contents = buildSparseNonAsciiChunk()
    const file = getTempFile('sparse-non-ascii-async.txt')

    await writeUtf8FileInChunks(file, contents)

    expect(readFileSync(file)).toEqual(Buffer.from(contents, 'utf8'))
  })
})
