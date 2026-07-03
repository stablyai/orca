import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  extractTerminalHttpLinks,
  getTerminalHttpLinkAtBufferPosition,
  getTerminalHttpLinkForMouseEvent,
  TERMINAL_HTTP_URL_MAX_LENGTH
} from './terminal-url-link-hit-testing'

afterEach(() => {
  vi.restoreAllMocks()
})

describe('extractTerminalHttpLinks', () => {
  it('extracts regular http links and trims terminal trailing punctuation', () => {
    const line = 'open https://example.com/path?x=1.'

    expect(extractTerminalHttpLinks(line)).toEqual([
      {
        url: 'https://example.com/path?x=1',
        startIndex: 'open '.length,
        endIndex: line.length - 1
      }
    ])
  })

  it('requires a word boundary before the http scheme', () => {
    expect(extractTerminalHttpLinks('prefixhttps://example.com/path')).toEqual([])
    expect(extractTerminalHttpLinks('prefix https://example.com/path')).toHaveLength(1)
  })

  it('rejects overlong pasted URL candidates before URL parsing', () => {
    const overlongUrl = `https://example.com/${'a'.repeat(TERMINAL_HTTP_URL_MAX_LENGTH)}`

    expect(extractTerminalHttpLinks(overlongUrl)).toEqual([])
  })

  it('scans large pasted terminal lines without regex match iteration', () => {
    const matchAllSpy = vi.spyOn(String.prototype, 'matchAll')
    const pastedPrefix = 'pasted terminal noise '.repeat(10_000)
    const line = `${pastedPrefix}https://example.com/docs?q=orca.`

    expect(extractTerminalHttpLinks(line)).toEqual([
      {
        url: 'https://example.com/docs?q=orca',
        startIndex: pastedPrefix.length,
        endIndex: line.length - 1
      }
    ])
    expect(matchAllSpy).not.toHaveBeenCalled()
  })
})

describe('terminal HTTP link hit testing', () => {
  type TestBufferLine = {
    isWrapped: boolean
    length: number
    translateToString: (
      trimRight?: boolean,
      startColumn?: number,
      endColumn?: number,
      outColumns?: number[]
    ) => string
  }

  function defaultColumnsForText(text: string): number[] {
    return Array.from({ length: text.length + 1 }, (_value, index) => index)
  }

  function makeBufferLine(
    text: string,
    options: { isWrapped?: boolean; columns?: number[] } = {}
  ): TestBufferLine {
    const columns = options.columns ?? defaultColumnsForText(text)
    return {
      isWrapped: options.isWrapped ?? false,
      length: text.length,
      translateToString: (
        _trimRight?: boolean,
        startColumn = 0,
        endColumn = text.length,
        outColumns?: number[]
      ) => {
        if (outColumns) {
          outColumns.length = 0
          for (let index = startColumn; index <= endColumn; index++) {
            outColumns.push(columns[index] ?? index)
          }
        }
        return text.slice(startColumn, endColumn)
      }
    }
  }

  function makeBuffer(
    rows: TestBufferLine[]
  ): Parameters<typeof getTerminalHttpLinkAtBufferPosition>[0] {
    return { getLine: (y: number) => rows[y] } as Parameters<
      typeof getTerminalHttpLinkAtBufferPosition
    >[0]
  }

  it('returns the URL at a buffer position without opening it', () => {
    const line = 'Open https://example.com/docs?q=orca now'

    expect(
      getTerminalHttpLinkAtBufferPosition(
        makeBuffer([makeBufferLine(line)]),
        { x: line.indexOf('example') + 1, y: 1 },
        80
      )
    ).toBe('https://example.com/docs?q=orca')
  })

  it('returns null when the buffer position is outside the URL', () => {
    const line = 'Open https://example.com/docs now'

    expect(
      getTerminalHttpLinkAtBufferPosition(makeBuffer([makeBufferLine(line)]), { x: 2, y: 1 }, 80)
    ).toBeNull()
  })

  // Why: the context-menu "Open in Default Browser" item hands this URL to
  // shell.openExternal, so a dangerous scheme under the cursor must never be
  // surfaced as an openable link.
  it.each(['file:///etc/passwd', 'javascript:alert(1)', 'smb://host/share', 'vscode://x'])(
    'returns null for the non-http scheme %s',
    (dangerousUrl) => {
      const line = `Open ${dangerousUrl} now`

      expect(
        getTerminalHttpLinkAtBufferPosition(
          makeBuffer([makeBufferLine(line)]),
          { x: line.indexOf(dangerousUrl) + 1, y: 1 },
          80
        )
      ).toBeNull()
    }
  )

  it('returns wrapped URLs from mouse coordinates', () => {
    const rows = [
      makeBufferLine('Visit https://exa'),
      makeBufferLine('mple.com/docs', { isWrapped: true })
    ]
    const screen = {
      getBoundingClientRect: () => ({
        left: 10,
        top: 20,
        width: 200,
        height: 40
      })
    }
    const terminal = {
      cols: 20,
      rows: 2,
      element: { querySelector: () => screen },
      buffer: {
        active: {
          viewportY: 0,
          getLine: (y: number) => rows[y]
        }
      }
    }

    expect(
      getTerminalHttpLinkForMouseEvent(
        terminal as unknown as Parameters<typeof getTerminalHttpLinkForMouseEvent>[0],
        {
          clientX: 30,
          clientY: 45
        }
      )
    ).toBe('https://example.com/docs')
  })
})
