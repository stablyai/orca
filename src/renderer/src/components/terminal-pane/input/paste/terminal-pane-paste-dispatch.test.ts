import { describe, expect, it } from 'vitest'
import { createPtyPreconnectInputBuffer } from '../../pty-transport/input/pty-preconnect-input-buffer'
import type { TerminalInputKind } from '../../../../../../shared/terminal/input/terminal-input-kind'
import {
  openUnboundTerminalPasteHold,
  pasteTextIntoTerminalPane
} from './terminal-pane-paste-dispatch'

describe('pasteTextIntoTerminalPane preconnect hold', () => {
  it('writes a short paste ahead of Enter typed while the clipboard was unread', async () => {
    const buffer = createPtyPreconnectInputBuffer()
    const transport = {
      isConnected: () => false,
      getPtyId: () => null,
      holdsInputUntilConnect: () => buffer.isBuffering(),
      holdPasteAheadOfLaterKeys: () => buffer.openPasteGate(),
      sendInput: (data: string, inputKind: TerminalInputKind) =>
        buffer.enqueue(data, 'ordinary', inputKind),
      sendInputAccepted: (data: string, inputKind: TerminalInputKind) =>
        buffer.enqueueAccepted(data, inputKind)
    }
    const terminal = {
      modes: { bracketedPasteMode: false },
      options: {},
      paste: (text: string) => {
        transport.sendInput(text, 'driving')
      },
      input: (data: string) => {
        transport.sendInput(data, 'driving')
      }
    }
    const hold = openUnboundTerminalPasteHold(transport)
    expect(hold).not.toBeNull()
    expect(buffer.enqueue('\r', 'ordinary', 'driving')).toBe(true)

    const result = await pasteTextIntoTerminalPane({
      pane: { id: 1, leafId: 'leaf', terminal },
      text: 'echo hi',
      source: 'keyboard',
      ptyId: null,
      runtime: { platform: 'darwin', runtimeKey: 'local:darwin', kind: 'local' },
      transport,
      inputKind: 'driving',
      isTargetCurrent: () => true,
      canContinue: () => true,
      holdPaste: hold
    })
    hold?.close()

    expect(result.status).toBe('pasted')
    const delivered: string[] = []
    await buffer.flush({
      isCurrent: () => true,
      sendInput: (data) => {
        delivered.push(data)
        return true
      },
      sendInputImmediate: () => true
    })
    expect(delivered).toEqual(['echo hi', '\r'])
  })
})
