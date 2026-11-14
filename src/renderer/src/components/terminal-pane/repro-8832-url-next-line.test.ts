/**
 * Issue #8832 — Cmd-click URL opens with next line's first word glued on.
 *
 * Repro of the issue's multi-line buffer:
 *   Repo: https://github.com/stablyai/orca/
 *   Description: 123
 *
 * Path hard-wrap reconstruction (from #8339) treats the next line's path-like
 * prefix as a URL continuation. HTTP hit-testing then consumes those logical
 * lines, so the opened URL becomes .../orca/Description.
 *
 * Re-run:
 *   pnpm exec vitest run src/renderer/src/components/terminal-pane/repro-8832-url-next-line.test.ts
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

function makeBufferLine(text: string): IBufferLine {
  return {
    isWrapped: false,
    length: text.length,
    getCell: () => undefined,
    translateToString: (
      _trimRight?: boolean,
      startColumn = 0,
      endColumn = text.length,
      outColumns?: number[]
    ) => {
      if (outColumns) {
        outColumns.length = 0
        for (let index = startColumn; index <= endColumn; index++) {
          outColumns.push(index)
        }
      }
      return text.slice(startColumn, endColumn)
    }
  } as IBufferLine
}

function issueBuffer(): { getLine(y: number): IBufferLine | undefined } {
  const rows = [makeBufferLine(LINE_1), makeBufferLine(LINE_2)]
  return { getLine: (y: number) => rows[y] }
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

  it('builds a multi-row path candidate that concatenates Description onto the URL', () => {
    const buffer = issueBuffer()
    const candidates = buildHardWrappedPathLogicalLineCandidates(buffer, 1)
    const multiRow = candidates.filter((candidate) => candidate.rows.length > 1)

    expect(multiRow.some((candidate) => candidate.text.includes('Description'))).toBe(true)

    const glued = multiRow.find((candidate) => candidate.text.includes('https://'))
    expect(glued).toBeDefined()
    // Boundary join: URL + path-like prefix of next line (colon kept in path fragment charset)
    expect(glued!.text).toContain('https://github.com/stablyai/orca/Description')
  })

  it('HTTP extraction on that logical line yields the buggy URL', () => {
    const buffer = issueBuffer()
    const candidates = buildCandidateLogicalLinesForBufferPosition(buffer, 1)
    const extracted = candidates.flatMap((line) => extractTerminalHttpLinks(line.text))

    expect(extracted.map((link) => link.url)).toContain(BUGGY_URL)
    // Single-line soft wrap alone would be correct — the multi-row candidate poisons the set
    const singleLineUrls = extractTerminalHttpLinks(LINE_1).map((link) => link.url)
    expect(singleLineUrls).toEqual([EXPECTED_URL])
  })

  it('openHttpLinkAtBufferPosition opens the glued URL when Cmd-clicking the URL row', () => {
    const buffer = issueBuffer()
    // Click mid-URL on the first buffer line (1-based y / 1-based-ish x used by hit-test)
    const urlStart = LINE_1.indexOf('https://')
    const opened = openHttpLinkAtBufferPosition(buffer, { x: urlStart + 10, y: 1 }, 120, {
      worktreeId: 'wt-repro-8832',
      forceSystemBrowser: true
    })

    expect(opened).toBe(true)
    expect(openUrlMock).toHaveBeenCalled()
    const openedUrl = openUrlMock.mock.calls[0]?.[0] as string
    // Conclusive bug: next line's first word is appended
    expect(openedUrl).toBe(BUGGY_URL)
    expect(openedUrl).not.toBe(EXPECTED_URL)
  })
})
