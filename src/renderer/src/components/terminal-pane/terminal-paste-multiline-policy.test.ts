import { describe, expect, it, vi } from 'vitest'

import {
  executeTerminalPastePlan,
  planTerminalPaste,
  type TerminalPasteTarget
} from './terminal-paste-coordinator'

function terminalTarget(): TerminalPasteTarget {
  return {
    kind: 'terminal',
    paneId: 1,
    leafId: 'leaf-1',
    ptyId: 'pty-1',
    runtime: {
      platform: 'win32',
      runtimeKey: 'local:win32',
      kind: 'local',
      isWindowsConpty: true
    }
  }
}

describe('terminal paste multiline policy', () => {
  it('uses coordinator metadata to bracket only multiline Windows paste text', async () => {
    const pasteText = vi.fn()
    const multilinePlan = planTerminalPaste({
      text: 'one\r\ntwo',
      source: 'keyboard',
      target: terminalTarget(),
      forceBracketedPasteForMultiline: true
    })
    const singleLinePlan = planTerminalPaste({
      text: 'one',
      source: 'keyboard',
      target: terminalTarget(),
      forceBracketedPasteForMultiline: true
    })

    await executeTerminalPastePlan(multilinePlan, {
      pasteText,
      isTargetCurrent: () => true
    })
    await executeTerminalPastePlan(singleLinePlan, {
      pasteText,
      isTargetCurrent: () => true
    })

    expect(multilinePlan.mode).toBe('bracketed-terminal')
    expect(singleLinePlan.mode).toBe('direct')
    expect(multilinePlan.newlinePolicy).toBe('terminal-cr')
    expect(singleLinePlan.newlinePolicy).toBe('preserve')
    expect(pasteText).toHaveBeenNthCalledWith(1, 'one\r\ntwo', { forceBracketedPaste: true })
    expect(pasteText).toHaveBeenNthCalledWith(2, 'one', { forceBracketedPaste: false })
  })
})
