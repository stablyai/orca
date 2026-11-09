import { describe, expect, it, vi } from 'vitest'

import '../../../../lib/paste-payload-corpus'

import './terminal-bracketed-paste'
import {
  BRACKETED_PASTE_END,
  BRACKETED_PASTE_START
} from '../../../../../../shared/terminal/input/terminal-bracketed-paste-text'
import { createRedactedPasteExecutionDiagnostic } from './terminal-paste-diagnostics'

import { chunkTerminalPastePlan } from './terminal-paste-chunks'
import { planTerminalPaste } from './terminal-paste-coordinator'
import { executeTerminalPastePlan } from './terminal-paste-executor'

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

function bracketedChunkedPlan() {
  return planTerminalPaste({
    text: '0123456789abcdef',
    source: 'keyboard',
    target: terminalTarget(),
    terminalBracketedPasteMode: true,
    maxDirectBytes: 4,
    maxChunkBytes: 4
  })
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

  it('redacts unsafe diagnostic reasons instead of echoing arbitrary text', () => {
    const secret = 'secret-token-from-exception'
    const plan = planTerminalPaste({
      text: 'safe payload',
      source: 'keyboard',
      target: terminalTarget()
    })

    const diagnostic = createRedactedPasteExecutionDiagnostic({
      chunksWritten: 0,
      durationMs: 7,
      plan,
      reason: `unexpected failure: ${secret}`,
      status: 'cancelled'
    })

    expect(diagnostic).toContain('status=cancelled')
    expect(diagnostic).toContain('reason=untrusted')
    expect(diagnostic).toContain('content=redacted')
    expect(diagnostic).not.toContain(secret)
    expect(diagnostic).not.toContain('unexpected failure')
  })

  it('closes an opened bracketed paste when stale focus cancels before payload chunks', async () => {
    let current = true
    const writePty = vi.fn<(data: string) => boolean>(() => true)
    const plan = planTerminalPaste({
      text: '0123456789abcdef',
      source: 'keyboard',
      target: terminalTarget(),
      terminalBracketedPasteMode: true,
      maxDirectBytes: 4,
      maxChunkBytes: 4
    })

    const result = await executeTerminalPastePlan(plan, {
      pasteText: vi.fn(),
      writePty,
      isTargetCurrent: () => current,
      canContinue: () => true,
      yieldToEventLoop: async () => {
        current = false
      }
    })

    expect(result).toMatchObject({ status: 'cancelled', reason: 'stale-target' })
    expect(writePty.mock.calls.map((call) => call[0])).toEqual([
      BRACKETED_PASTE_START,
      BRACKETED_PASTE_END
    ])
  })

  it('reports a timed-out bracketed close on a stale target as an operation timeout', async () => {
    vi.useFakeTimers()
    try {
      let current = true
      const writes: string[] = []
      const writePty = vi.fn((data: string) => {
        writes.push(data)
        return data === BRACKETED_PASTE_END ? new Promise<boolean>(() => {}) : true
      })

      const execution = executeTerminalPastePlan(bracketedChunkedPlan(), {
        pasteText: vi.fn(),
        writePty,
        isTargetCurrent: () => current,
        canContinue: () => true,
        yieldToEventLoop: async () => {
          current = false
        },
        operationTimeoutMs: 25
      })
      await vi.advanceTimersByTimeAsync(25)
      await vi.advanceTimersByTimeAsync(25)

      await expect(execution).resolves.toMatchObject({
        status: 'cancelled',
        reason: 'operation-timeout'
      })
      expect(writes).toEqual([BRACKETED_PASTE_START, BRACKETED_PASTE_END])
    } finally {
      vi.useRealTimers()
    }
  })

  it('closes an opened bracketed paste when the PTY writer throws', async () => {
    const writes: string[] = []
    const writePty = vi.fn<(data: string) => boolean>((data) => {
      writes.push(data)
      if (data !== BRACKETED_PASTE_START && data !== BRACKETED_PASTE_END) {
        throw new Error('writer gone')
      }
      return true
    })

    await expect(
      executeTerminalPastePlan(bracketedChunkedPlan(), {
        pasteText: vi.fn(),
        writePty,
        isTargetCurrent: () => true,
        canContinue: () => true,
        yieldToEventLoop: async () => {}
      })
    ).rejects.toThrow('writer gone')
    expect(writes).toEqual([BRACKETED_PASTE_START, '0123', BRACKETED_PASTE_END])
  })
})
