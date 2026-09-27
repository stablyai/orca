// @vitest-environment happy-dom

import { Terminal } from '@xterm/xterm'
import { expect, it, vi } from 'vitest'
import { captureDictationPreviewTarget } from '../dictation/dictation-preview-target'
import { installPreviewTerminalDictation } from './preview-terminal-dictation'

it.each(['before insertion', 'during paste planning'])(
  'rejects a changed local PTY %s without relying on disposal',
  async (timing) => {
    const container = document.createElement('div')
    document.body.appendChild(container)
    const terminal = new Terminal()
    const paste = vi.spyOn(terminal, 'paste').mockImplementation(() => {})
    const input = vi.fn(async () => true)
    Object.assign(window, { api: { terminalPreview: { input } } })
    let ptyId = 'pty-a'
    const args = {
      ptyId,
      getPtyId: () => ptyId,
      container,
      terminal,
      getTerminalInput: () => null
    }
    const dispose = installPreviewTerminalDictation(args)
    try {
      const target = captureDictationPreviewTarget(container)
      if (!target) {
        throw new Error('Missing dictation target')
      }
      expect(await target.insertText('current')).toBe(true)
      paste.mockClear()
      input.mockClear()
      if (timing === 'before insertion') {
        ptyId = 'pty-b'
      }
      const insertion = target.insertText('stale')
      ptyId = 'pty-b'
      expect(await insertion).toBe(false)
      expect(paste).not.toHaveBeenCalled()
      expect(input).not.toHaveBeenCalled()
    } finally {
      dispose()
      terminal.dispose()
      container.remove()
      vi.restoreAllMocks()
    }
  }
)
