import { describe, expect, it } from 'vitest'

import '../../../../../../shared/paste-payload-corpus'

import './terminal-bracketed-paste'

import { chunkTerminalPastePlan } from './terminal-paste-chunks'
import { planTerminalPaste } from './terminal-paste-coordinator'

import type { TerminalPasteTarget } from './terminal-paste-model'

function terminalTarget(overrides: Partial<TerminalPasteTarget> = {}): TerminalPasteTarget {
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
    },
    ...overrides
  }
}

describe('terminal paste coordinator', () => {
  it('counts CRLF by its exact encoded size at paste limits', () => {
    const altEnter = planTerminalPaste({
      text: 'a\r\n',
      source: 'keyboard',
      target: terminalTarget(),
      windowsInputRecordNewline: 'alt-enter',
      maxDirectBytes: 3,
      maxBytes: 3
    })
    const csiU = planTerminalPaste({
      text: 'a\r\n',
      source: 'keyboard',
      target: terminalTarget(),
      windowsInputRecordNewline: 'csi-u',
      maxDirectBytes: 8,
      maxBytes: 8
    })

    expect(altEnter.mode).toBe('windows-input-record')
    expect(chunkTerminalPastePlan(altEnter).join('')).toBe('a\x1b\r')
    expect(csiU.mode).toBe('windows-input-record')
    expect(chunkTerminalPastePlan(csiU).join('')).toBe('a\x1b[13;2u')
  })
})
