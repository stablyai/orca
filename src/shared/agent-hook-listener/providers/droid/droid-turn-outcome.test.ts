import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { readDroidTurnVerdictAsync } from './droid-turn-outcome'

const line = (record: Record<string, unknown>) => `${JSON.stringify(record)}\n`
const userRecord = (id: string, content: unknown) =>
  line({ type: 'message', id, message: { role: 'user', content } })
const outcome = (turnId: string, reason: string) =>
  line({ type: 'agent_turn_outcome', turnId, reason, resultKind: 'text' })

let root: string
let transcriptPath: string

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'orca-droid-verdict-'))
  transcriptPath = join(root, 'session.jsonl')
})

afterEach(() => {
  rmSync(root, { recursive: true, force: true })
})

describe('readDroidTurnVerdictAsync', () => {
  it.each([
    ['process_exit', 'cancellation'],
    ['permission_rejected', 'failure'],
    ['completed', null],
    ['some_future_reason', null]
  ])('maps %s as Droid does', async (reason, verdict) => {
    writeFileSync(transcriptPath, userRecord('turn-1', 'go') + outcome('turn-1', reason))
    await expect(readDroidTurnVerdictAsync(transcriptPath)).resolves.toBe(verdict)
  })

  it.each([
    ['prompt', 'next'],
    ['tool result', [{ type: 'tool_result', tool_use_id: 'call-1', content: 'ok' }]]
  ])(
    'does not reuse an earlier turn outcome once a %s starts the next turn',
    async (_, content) => {
      writeFileSync(
        transcriptPath,
        userRecord('turn-1', 'go') + outcome('turn-1', 'cancelled') + userRecord('turn-2', content)
      )
      await expect(readDroidTurnVerdictAsync(transcriptPath)).resolves.toBeUndefined()
    }
  )
})
