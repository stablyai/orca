import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { appendFileSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  createMuseSessionLogState,
  findMuseSessionLogPath,
  readMusePendingUserInput
} from './muse-session-log'

const SESSION_ID = '01a0caa3-0e77-7d41-bad7-46283a45633d'
const PROMPT_ID = '01a0caa3-a25a-7810-8229-4de04b2e7ca3'
const QUESTION = {
  id: 'fav_color',
  header: 'Color',
  question: 'What is your favorite color?',
  options: [{ label: 'Blue' }, { label: 'Green' }, { label: 'Red' }]
}

function logLine(event: Record<string, unknown>): string {
  return `${JSON.stringify({
    schema_version: 1,
    stream: { kind: 'session', id: SESSION_ID },
    record_type: 'event',
    payload_type: 'runtime.session',
    payload: { kind: 'run', run_id: 'fdada6f1-d403-41d8-b610-52f1d8489334', event }
  })}\n`
}

const requested = (promptId = PROMPT_ID): string =>
  logLine({
    kind: 'user_input_prompt_requested',
    prompt_id: promptId,
    tool_name: 'request_user_input',
    questions: [QUESTION]
  })
const settled = (promptId = PROMPT_ID): string =>
  logLine({ kind: 'user_input_prompt_settled', prompt_id: promptId, outcome: 'answered' })

function localShard(sessionId: string): string[] {
  const hex = sessionId.replace(/-/g, '').slice(0, 12)
  const date = new Date(Number.parseInt(hex, 16))
  return [
    String(date.getFullYear()),
    String(date.getMonth() + 1).padStart(2, '0'),
    String(date.getDate()).padStart(2, '0')
  ]
}

describe('muse session log', () => {
  let sessionsDir: string
  let logPath: string

  beforeEach(() => {
    sessionsDir = mkdtempSync(join(tmpdir(), 'muse-session-log-'))
    const dir = join(sessionsDir, ...localShard(SESSION_ID), SESSION_ID)
    mkdirSync(dir, { recursive: true })
    logPath = join(dir, 'session.jsonl')
  })

  afterEach(() => {
    rmSync(sessionsDir, { recursive: true, force: true })
  })

  it('finds the log in the date shard named by the UUIDv7 timestamp', () => {
    writeFileSync(logPath, '')
    expect(findMuseSessionLogPath(SESSION_ID, sessionsDir)).toBe(logPath)
  })

  it('returns undefined for a missing log or a non-v7 session id', () => {
    expect(findMuseSessionLogPath(SESSION_ID, sessionsDir)).toBeUndefined()
    expect(
      findMuseSessionLogPath('1471f5e6-bd60-41a2-bfcf-c9086dbd4092', sessionsDir)
    ).toBeUndefined()
  })

  it('reads prompts batched inside a retained_frame', () => {
    const frame = (line: string): string =>
      `${JSON.stringify({ record_type: 'retained_frame', children: [{ record_json: line.trim() }] })}\n`
    writeFileSync(logPath, frame(requested()))
    const log = createMuseSessionLogState(SESSION_ID)
    expect(readMusePendingUserInput(log, undefined, sessionsDir)?.promptId).toBe(PROMPT_ID)
    appendFileSync(logPath, frame(settled()))
    expect(readMusePendingUserInput(log, undefined, sessionsDir)).toBeUndefined()
  })

  it('ignores a prompt left open by an earlier run', () => {
    writeFileSync(logPath, requested())
    const log = createMuseSessionLogState(SESSION_ID)
    expect(
      readMusePendingUserInput(log, 'fdada6f1-d403-41d8-b610-52f1d8489334', sessionsDir)?.promptId
    ).toBe(PROMPT_ID)
    expect(
      readMusePendingUserInput(log, '11111111-2222-4333-8444-555555555555', sessionsDir)
    ).toBeUndefined()
  })

  it('returns the open prompt and clears it once settled', () => {
    writeFileSync(logPath, requested())
    const log = createMuseSessionLogState(SESSION_ID)
    expect(readMusePendingUserInput(log, undefined, sessionsDir)).toEqual({
      promptId: PROMPT_ID,
      runId: 'fdada6f1-d403-41d8-b610-52f1d8489334',
      questions: [QUESTION]
    })
    // Re-reading with no new bytes keeps the prompt pending.
    expect(readMusePendingUserInput(log, undefined, sessionsDir)?.promptId).toBe(PROMPT_ID)

    appendFileSync(logPath, settled())
    expect(readMusePendingUserInput(log, undefined, sessionsDir)).toBeUndefined()
  })

  it('holds a partial trailing line until it is completed', () => {
    const line = requested()
    writeFileSync(logPath, line.slice(0, 40))
    const log = createMuseSessionLogState(SESSION_ID)
    expect(readMusePendingUserInput(log, undefined, sessionsDir)).toBeUndefined()

    appendFileSync(logPath, line.slice(40))
    expect(readMusePendingUserInput(log, undefined, sessionsDir)?.questions).toEqual([QUESTION])
  })

  it('reports the newest of several open prompts', () => {
    const second = '01a0caa4-0000-7000-8000-000000000001'
    writeFileSync(logPath, `${requested()}${requested(second)}`)
    const log = createMuseSessionLogState(SESSION_ID)
    expect(readMusePendingUserInput(log, undefined, sessionsDir)?.promptId).toBe(second)

    appendFileSync(logPath, settled(second))
    expect(readMusePendingUserInput(log, undefined, sessionsDir)?.promptId).toBe(PROMPT_ID)
  })

  it('locates a log created after the first read', () => {
    const log = createMuseSessionLogState(SESSION_ID)
    expect(readMusePendingUserInput(log, undefined, sessionsDir)).toBeUndefined()

    writeFileSync(logPath, requested())
    expect(readMusePendingUserInput(log, undefined, sessionsDir)?.promptId).toBe(PROMPT_ID)
  })
})
