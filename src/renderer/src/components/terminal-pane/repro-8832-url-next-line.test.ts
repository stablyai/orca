/**
 * Issue #8832 — Cmd-click URL must not glue the next logical line.
 *
 * Root cause: path hard-wrap reconstruction (from #8339) still joins a URL
 * suffix ending in `/` with the next row's path-like prefix. HTTP hit-testing
 * must not consume those candidates; it uses soft-wrap, framed hard-wrap HTTP,
 * and edge-wrap reconstruction only.
 *
 * Re-run:
 *   pnpm exec vitest run --config config/vitest.config.ts \
 *     src/renderer/src/components/terminal-pane/repro-8832-url-next-line.test.ts
 */
import type { IBufferLine } from '@xterm/xterm'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { registerHttpLinkStoreAccessor } from '@/lib/http-link-routing'
import { buildCandidateLogicalLinesForBufferPosition } from './terminal-file-link-hit-testing'
import {
  extractTerminalHttpLinks,
  openHttpLinkAtBufferPosition
} from './terminal-url-link-hit-testing'
import { buildHardWrappedPathLogicalLineCandidates } from './wrapped-terminal-link-ranges'

const LINE_1 = 'Repo: https://github.com/stablyai/orca/'
const LINE_2 = 'Description: 123'
const EXPECTED_URL = 'https://github.com/stablyai/orca/'
const BUGGY_URL = 'https://github.com/stablyai/orca/Description'

const openUrlMock = vi.fn()

function makeBufferLine(
  text: string,
  options: { cols?: number; isWrapped?: boolean } = {}
): IBufferLine {
  const cols = options.cols ?? Math.max(text.length, 80)
  const padded = text.padEnd(cols)
  return {
    isWrapped: options.isWrapped ?? false,
    length: cols,
    getCell: () => undefined,
    translateToString: (
      _trimRight?: boolean,
      startColumn = 0,
      endColumn = padded.length,
      outColumns?: number[]
    ) => {
      if (outColumns) {
        outColumns.length = 0
        for (let index = startColumn; index <= endColumn; index++) {
          outColumns.push(index)
        }
      }
      return padded.slice(startColumn, endColumn)
    }
  } as IBufferLine
}

function twoRowBuffer(
  row0: string,
  row1: string,
  options: { cols?: number; softWrapped?: boolean } = {}
): { getLine(y: number): IBufferLine | undefined } {
  const cols = options.cols ?? 120
  const rows = [
    makeBufferLine(row0, { cols, isWrapped: false }),
    makeBufferLine(row1, { cols, isWrapped: options.softWrapped === true })
  ]
  return { getLine: (y: number) => rows[y] }
}

function issueBuffer(): { getLine(y: number): IBufferLine | undefined } {
  return twoRowBuffer(LINE_1, LINE_2, { cols: 120 })
}

function openUrlAt(
  buffer: { getLine(y: number): IBufferLine | undefined },
  x: number,
  y: number,
  cols = 120
) {
  openUrlMock.mockReset()
  const opened = openHttpLinkAtBufferPosition(buffer, { x, y }, cols, {
    worktreeId: 'wt-repro-8832',
    forceSystemBrowser: true
  })
  return { opened, url: openUrlMock.mock.calls[0]?.[0] as string | undefined }
}

describe('#8832 hard-wrapped path candidates glue next-line text into URLs', () => {
  beforeEach(() => {
    vi.stubGlobal('navigator', { userAgent: 'Macintosh' })
    vi.stubGlobal('window', { api: { shell: { openUrl: openUrlMock } } })
    registerHttpLinkStoreAccessor(() => ({
      settings: { openLinksInApp: false },
      setActiveWorktree: vi.fn(),
      createBrowserTab: vi.fn()
    }))
    openUrlMock.mockReset()
  })

  afterEach(() => {
    vi.unstubAllGlobals()
  })

  it('still builds a multi-row path candidate that concatenates Description onto the URL', () => {
    // Why: documents the path-reconstruction poison that HTTP hit-testing must
    // not consume. File links remain protected by existence checks.
    const buffer = issueBuffer()
    const candidates = buildHardWrappedPathLogicalLineCandidates(buffer, 1)
    const multiRow = candidates.filter((candidate) => candidate.rows.length > 1)

    expect(multiRow.some((candidate) => candidate.text.includes('Description'))).toBe(true)

    const glued = multiRow.find((candidate) => candidate.text.includes('https://'))
    expect(glued).toBeDefined()
    expect(glued!.text).toContain('https://github.com/stablyai/orca/Description')
  })

  it('HTTP extraction on a path logical line still yields the glued URL', () => {
    const buffer = issueBuffer()
    const candidates = buildCandidateLogicalLinesForBufferPosition(buffer, 1)
    const extracted = candidates.flatMap((line) => extractTerminalHttpLinks(line.text))

    expect(extracted.map((link) => link.url)).toContain(BUGGY_URL)
    const singleLineUrls = extractTerminalHttpLinks(LINE_1).map((link) => link.url)
    expect(singleLineUrls).toEqual([EXPECTED_URL])
  })

  it('openHttpLinkAtBufferPosition opens the unglued URL when Cmd-clicking the URL row', () => {
    const buffer = issueBuffer()
    const urlStart = LINE_1.indexOf('https://')
    const { opened, url } = openUrlAt(buffer, urlStart + 10, 1)

    expect(opened).toBe(true)
    expect(url).toBe(EXPECTED_URL)
    expect(url).not.toBe(BUGGY_URL)
  })

  it.each([
    ['Chinese label', '说明: 中文路径/文件.ts'],
    ['Windows path', 'C:\\Users\\demo\\project\\README.md'],
    ['POSIX path', '/usr/local/bin/orca'],
    ['relative path', './src/main/index.ts'],
    ['UNC-ish path', '\\\\server\\share\\file.txt']
  ])('does not glue a mid-row URL to a next-line %s', (_label, nextLine) => {
    const row0 = 'See https://example.com/docs/'
    const buffer = twoRowBuffer(row0, nextLine, { cols: 100 })
    const urlStart = row0.indexOf('https://')
    const { opened, url } = openUrlAt(buffer, urlStart + 8, 1)

    expect(opened).toBe(true)
    expect(url).toBe('https://example.com/docs/')
    expect(url).not.toMatch(/说明|Users|usr|src|server/)
  })

  it('still joins a soft-wrapped multi-line URL via native wrap metadata', () => {
    const cols = 40
    const url = 'https://example.com/very/long/path/segments/that/continue/more'
    const row0 = url.slice(0, cols)
    const row1 = url.slice(cols)
    const buffer = twoRowBuffer(row0, row1, { cols, softWrapped: true })
    const first = openUrlAt(buffer, 11, 1, cols)
    const second = openUrlAt(buffer, 5, 2, cols)

    expect(first.opened).toBe(true)
    expect(first.url).toBe(url)
    expect(second.opened).toBe(true)
    expect(second.url).toBe(url)
  })

  it('still joins an edge-wrapped multi-line URL without wrap metadata', () => {
    const cols = 40
    const url = 'https://example.com/very/long/path/segments/that/continue/more'
    const row0 = url.slice(0, cols)
    const row1 = url.slice(cols)
    expect(row0).toHaveLength(cols)
    const buffer = twoRowBuffer(row0, row1, { cols, softWrapped: false })
    const first = openUrlAt(buffer, 11, 1, cols)
    const second = openUrlAt(buffer, 5, 2, cols)

    expect(first.opened).toBe(true)
    expect(first.url).toBe(url)
    expect(second.opened).toBe(true)
    expect(second.url).toBe(url)
  })

  it('does not treat file:// as an HTTP link (file routing stays separate)', () => {
    const row0 = 'open file:///Users/demo/project/README.md'
    const buffer = twoRowBuffer(row0, 'next: line', { cols: 100 })
    const { opened, url } = openUrlAt(buffer, row0.indexOf('file://') + 4, 1)

    expect(opened).toBe(false)
    expect(url).toBeUndefined()
  })

  it('opens only the HTTP URL when a Windows path shares the same row', () => {
    const row0 = 'https://example.com/a C:\\Users\\demo\\file.txt'
    const buffer = twoRowBuffer(row0, 'Description: more', { cols: 100 })
    const { opened, url } = openUrlAt(buffer, 8, 1)

    expect(opened).toBe(true)
    expect(url).toBe('https://example.com/a')
  })
})
