import { describe, expect, it } from 'vitest'
import { Terminal } from '@xterm/headless'
import { POST_REPLAY_MODE_RESET, POST_REPLAY_REATTACH_RESET } from './layout-serialization'

const OLD_REATTACH_RESET_WITHOUT_CURSOR_STYLE = '\x1b[?25h\x1b[?1004l'

type DecPrivateCursorState = {
  cursorStyle?: string
  cursorBlink?: boolean
}

type XtermWithCoreService = Terminal & {
  _core?: {
    coreService?: {
      decPrivateModes?: DecPrivateCursorState
    }
    _coreService?: {
      decPrivateModes?: DecPrivateCursorState
    }
  }
}

function readDecPrivateCursorState(term: Terminal): DecPrivateCursorState {
  const core = (term as XtermWithCoreService)._core
  const cursorState = core?.coreService?.decPrivateModes ?? core?._coreService?.decPrivateModes
  return cursorState ? { ...cursorState } : {}
}

function writeTerminal(term: Terminal, data: string): Promise<void> {
  return new Promise((resolve) => term.write(data, resolve))
}

describe('terminal replay cursor state reset', () => {
  it('clears stale DECSCUSR cursor overrides after live reattach replay', async () => {
    const term = new Terminal({
      cols: 80,
      rows: 24,
      allowProposedApi: true,
      cursorStyle: 'bar',
      cursorBlink: true
    })

    try {
      await writeTerminal(term, '\x1b[2 q')
      expect(readDecPrivateCursorState(term)).toMatchObject({
        cursorStyle: 'block',
        cursorBlink: false
      })

      await writeTerminal(term, OLD_REATTACH_RESET_WITHOUT_CURSOR_STYLE)
      expect(readDecPrivateCursorState(term)).toMatchObject({
        cursorStyle: 'block',
        cursorBlink: false
      })

      await writeTerminal(term, POST_REPLAY_REATTACH_RESET)
      const cursorState = readDecPrivateCursorState(term)
      expect(cursorState.cursorStyle).toBeUndefined()
      expect(cursorState.cursorBlink).toBeUndefined()
    } finally {
      term.dispose()
    }
  })

  it('clears stale DECSCUSR cursor overrides after cold-restore replay', async () => {
    const term = new Terminal({
      cols: 80,
      rows: 24,
      allowProposedApi: true,
      cursorStyle: 'bar',
      cursorBlink: true
    })

    try {
      await writeTerminal(term, '\x1b[6 q')
      expect(readDecPrivateCursorState(term)).toMatchObject({
        cursorStyle: 'bar',
        cursorBlink: false
      })

      await writeTerminal(term, POST_REPLAY_MODE_RESET)
      const cursorState = readDecPrivateCursorState(term)
      expect(cursorState.cursorStyle).toBeUndefined()
      expect(cursorState.cursorBlink).toBeUndefined()
    } finally {
      term.dispose()
    }
  })
})
