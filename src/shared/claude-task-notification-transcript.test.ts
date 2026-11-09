import { appendFileSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import {
  readClaudeTaskTranscriptPosition,
  readClaudeTerminalTaskNotifications
} from './claude-task-notification-transcript'

const SESSION_ID = 'session-1'

describe('Claude task notification transcript evidence', () => {
  let directory: string
  let transcriptPath: string

  beforeEach(() => {
    directory = mkdtempSync(join(tmpdir(), 'orca-claude-task-notification-'))
    transcriptPath = join(directory, 'session.jsonl')
    writeFileSync(transcriptPath, '')
  })

  afterEach(() => {
    rmSync(directory, { recursive: true, force: true })
  })

  it('accepts only current-session provider-authored terminal task notifications', async () => {
    writeFileSync(
      transcriptPath,
      [
        record('task-1', 'completed', { sessionId: 'other-session' }),
        record('task-1', 'completed', { promptSource: 'user' }),
        record('task-1', 'completed', { origin: { kind: 'user' } })
      ].join('')
    )
    const position = (await readClaudeTaskTranscriptPosition(SESSION_ID, transcriptPath))!
    appendFileSync(transcriptPath, record('task-1', 'completed'))

    expect(await readClaudeTerminalTaskNotifications(position, position.byteOffset)).toEqual({
      available: true,
      notifications: [{ taskId: 'task-1', byteOffset: position.byteOffset }]
    })
  })

  it('does not let a notification from before a resumed task end that incarnation', async () => {
    writeFileSync(transcriptPath, record('task-1', 'completed'))
    const resumedPosition = (await readClaudeTaskTranscriptPosition(SESSION_ID, transcriptPath))!

    expect(
      await readClaudeTerminalTaskNotifications(resumedPosition, resumedPosition.byteOffset)
    ).toEqual({ available: true, notifications: [] })

    appendFileSync(transcriptPath, record('task-1', 'completed'))
    expect(
      await readClaudeTerminalTaskNotifications(resumedPosition, resumedPosition.byteOffset)
    ).toMatchObject({
      available: true,
      notifications: [{ taskId: 'task-1' }]
    })
  })

  it('does not accept terminal evidence outside the bounded scan window', async () => {
    const position = (await readClaudeTaskTranscriptPosition(SESSION_ID, transcriptPath))!
    appendFileSync(transcriptPath, record('task-1', 'completed'))
    appendFileSync(transcriptPath, `${'x'.repeat(4 * 1024 * 1024)}\n`)

    expect(await readClaudeTerminalTaskNotifications(position, position.byteOffset)).toEqual({
      available: true,
      notifications: []
    })
  })
})

function record(
  taskId: string,
  status: string,
  overrides: {
    sessionId?: string
    promptSource?: string
    origin?: { kind: string }
  } = {}
): string {
  return `${JSON.stringify({
    type: 'user',
    sessionId: overrides.sessionId ?? SESSION_ID,
    promptSource: overrides.promptSource ?? 'system',
    origin: overrides.origin ?? { kind: 'task-notification' },
    message: {
      role: 'user',
      content: `<task-notification>\n<task-id>${taskId}</task-id>\n<status>${status}</status>\n<summary>finished</summary>\n</task-notification>`
    }
  })}\n`
}
