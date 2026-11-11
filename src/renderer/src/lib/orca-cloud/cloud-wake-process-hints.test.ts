import { afterEach, describe, expect, it } from 'vitest'
import {
  captureWakeProcessHint,
  detectForegroundCommand,
  dismissWakeProcessHint,
  getWakeProcessHint,
  historyEndRow,
  readTerminalTail,
  resetWakeProcessCapture,
  resetWakeProcessHintsForTests
} from './cloud-wake-process-hints'

afterEach(() => resetWakeProcessHintsForTests())

describe('detectForegroundCommand', () => {
  it('finds a dev server still running at the end of the scrollback', () => {
    expect(
      detectForegroundCommand([
        'ubuntu@sbx:~/project$ ls',
        'README.md',
        'ubuntu@sbx:~/project$ python3 -m http.server 8000',
        'Serving HTTP on 0.0.0.0 port 8000 (http://0.0.0.0:8000/) ...',
        ''
      ])
    ).toEqual({ command: 'python3 -m http.server 8000' })
  })

  it('returns null for a shell idle at a prompt', () => {
    expect(detectForegroundCommand(['$ npm test', 'ok', 'ubuntu@sbx:~/project$ '])).toBeNull()
    expect(detectForegroundCommand(['$ npm test', 'ok', '$ git st'])).toBeNull()
  })

  it('returns null when no prompt line is readable', () => {
    expect(detectForegroundCommand(['compiling…', 'done'])).toBeNull()
    expect(detectForegroundCommand([])).toBeNull()
  })
})

describe('wake process hints', () => {
  const running = ['❯ pnpm dev', '  ready on http://localhost:3000']

  it('captures once per sleep: a later look (the fresh prompt after wake) does not overwrite it', () => {
    captureWakeProcessHint('leaf-1', running)
    captureWakeProcessHint('leaf-1', ['$ '])
    expect(getWakeProcessHint('leaf-1')).toEqual({ command: 'pnpm dev' })
  })

  it('only panes that had a process get a hint', () => {
    captureWakeProcessHint('leaf-busy', running)
    captureWakeProcessHint('leaf-idle', ['$ '])
    expect(getWakeProcessHint('leaf-busy')).not.toBeNull()
    expect(getWakeProcessHint('leaf-idle')).toBeNull()
  })

  it('dismiss clears it; the next sleep captures again', () => {
    captureWakeProcessHint('leaf-1', running)
    dismissWakeProcessHint('leaf-1')
    expect(getWakeProcessHint('leaf-1')).toBeNull()
    resetWakeProcessCapture(['leaf-1'])
    captureWakeProcessHint('leaf-1', running)
    expect(getWakeProcessHint('leaf-1')).toEqual({ command: 'pnpm dev' })
  })

  it('finds where the history ends on screen, or null when it fills the pane', () => {
    const screen = (lines: string[], rows: number) => ({
      rows,
      buffer: {
        active: {
          length: lines.length,
          viewportY: 0,
          getLine: (index: number) => ({ translateToString: () => lines[index] ?? '' })
        }
      }
    })
    expect(historyEndRow(screen(['$ python3 -m http.server', 'Serving…', '', ''], 4))).toBe(2)
    expect(historyEndRow(screen(['a', 'b', 'c', 'd'], 4))).toBeNull()
    expect(historyEndRow(screen(['', '', ''], 3))).toBeNull()
  })

  it('reads the tail of an xterm buffer', () => {
    const lines = ['a', 'b', 'c']
    const terminal = {
      buffer: {
        active: {
          length: lines.length,
          getLine: (index: number) => ({ translateToString: () => lines[index]! })
        }
      }
    }
    expect(readTerminalTail(terminal, 2)).toEqual(['b', 'c'])
  })
})
