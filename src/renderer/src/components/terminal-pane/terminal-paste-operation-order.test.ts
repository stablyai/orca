import { describe, expect, it } from 'vitest'

import { sendAgentDraftPasteContent } from '@/lib/agent-draft-paste-content'
import {
  BRACKETED_PASTE_END,
  BRACKETED_PASTE_START,
  wrapTerminalBracketedPasteText
} from './terminal-bracketed-paste'
import { executeTerminalPastePlan, planTerminalPaste } from './terminal-paste-coordinator'
import { runTerminalPtyInputTransaction } from './terminal-pty-input-transaction'

function chunkedWindowsPaste() {
  return planTerminalPaste({
    text: 'user-line-1\nuser-line-2',
    source: 'keyboard',
    target: {
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
    },
    terminalBracketedPasteMode: true,
    maxDirectBytes: 4,
    maxChunkBytes: 12
  })
}

describe('terminal paste operation ordering', () => {
  it('starts an uncontended paste operation synchronously', async () => {
    let started = false
    const operation = runTerminalPtyInputTransaction('pty-1', async () => {
      started = true
    })

    expect(started).toBe(true)
    await operation
  })

  it('keeps startup context outside an active chunked user paste frame', async () => {
    const writes: string[] = []
    let startupDraft: Promise<boolean> | null = null
    const writePty = async (data: string): Promise<boolean> => {
      writes.push(data)
      return true
    }

    const userPasteResult = await executeTerminalPastePlan(chunkedWindowsPaste(), {
      pasteText: () => {},
      writePty,
      yieldToEventLoop: async () => {
        startupDraft ??= sendAgentDraftPasteContent(null, 'pty-1', 'GENERATED_CONTEXT', writePty)
      }
    })
    await startupDraft

    expect(userPasteResult.status).toBe('pasted')
    expect(writes).toEqual([
      BRACKETED_PASTE_START,
      'user-line-1\r',
      'user-line-2',
      BRACKETED_PASTE_END,
      wrapTerminalBracketedPasteText('GENERATED_CONTEXT')
    ])
  })

  it('waits for an active startup frame before opening a user paste frame', async () => {
    const writes: { owner: 'startup' | 'user'; data: string }[] = []
    let releaseStartup!: () => void
    let startupOpened!: () => void
    const opened = new Promise<void>((resolve) => {
      startupOpened = resolve
    })
    const startup = sendAgentDraftPasteContent(
      null,
      'pty-1',
      'G'.repeat(64 * 1024 + 1),
      async (data) => {
        writes.push({ owner: 'startup', data })
        if (data === BRACKETED_PASTE_START) {
          startupOpened()
          await new Promise<void>((resolve) => {
            releaseStartup = resolve
          })
        }
        return true
      }
    )
    await opened

    const user = executeTerminalPastePlan(chunkedWindowsPaste(), {
      pasteText: () => {},
      writePty: async (data) => {
        writes.push({ owner: 'user', data })
        return true
      },
      yieldToEventLoop: async () => {}
    })
    await Promise.resolve()
    expect(writes).toEqual([{ owner: 'startup', data: BRACKETED_PASTE_START }])

    releaseStartup()
    await expect(Promise.all([startup, user])).resolves.toEqual([
      true,
      expect.objectContaining({ status: 'pasted' })
    ])
    const firstUserWrite = writes.findIndex(({ owner }) => owner === 'user')
    expect(firstUserWrite).toBeGreaterThan(0)
    expect(writes.slice(0, firstUserWrite).every(({ owner }) => owner === 'startup')).toBe(true)
    expect(writes.slice(firstUserWrite).every(({ owner }) => owner === 'user')).toBe(true)
    expect(writes[firstUserWrite]?.data).toBe(BRACKETED_PASTE_START)
    expect(writes.at(-1)?.data).toBe(BRACKETED_PASTE_END)
  })

  it('does not block paste operations for another PTY', async () => {
    let releaseFirst!: () => void
    let firstStarted!: () => void
    const started = new Promise<void>((resolve) => {
      firstStarted = resolve
    })
    const first = runTerminalPtyInputTransaction('pty-1', async () => {
      firstStarted()
      await new Promise<void>((resolve) => {
        releaseFirst = resolve
      })
    })
    await started

    await expect(
      runTerminalPtyInputTransaction('pty-2', async () => 'second-complete')
    ).resolves.toBe('second-complete')
    releaseFirst()
    await first
  })

  it('releases a PTY after a failed paste operation', async () => {
    await expect(
      runTerminalPtyInputTransaction('pty-1', async () => {
        throw new Error('write failed')
      })
    ).rejects.toThrow('write failed')

    await expect(runTerminalPtyInputTransaction('pty-1', async () => 'recovered')).resolves.toBe(
      'recovered'
    )
  })
})
