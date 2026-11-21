import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, expect, it } from 'vitest'
import { createHookListenerState } from '../../listener-state'
import { normalizeHookPayload } from '../../normalization/normalize-hook-payload'
import { nextHookTranscriptPollDelay } from '../../transcript-poll-policy'
import {
  pollAntigravityTranscriptStatus,
  readAntigravityTranscriptPoll
} from './antigravity-transcript-poll'

let dir: string
let state: ReturnType<typeof createHookListenerState>

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'agy-settled-poll-'))
  state = createHookListenerState()
})

afterEach(() => {
  rmSync(dir, { recursive: true, force: true })
})

async function paneWithSubagent(index: number, proven: boolean): Promise<string> {
  const paneKey = `tab-${index}:${index.toString(16).padStart(8, '0')}-0000-4000-8000-000000000000`
  const root = `root-${index}`
  const generated = join(dir, root, '.system_generated')
  mkdirSync(join(generated, 'logs'), { recursive: true })
  mkdirSync(join(generated, 'subagents'), { recursive: true })
  const transcriptPath = join(generated, 'logs', 'transcript.jsonl')
  writeFileSync(
    transcriptPath,
    `${JSON.stringify({ source: 'USER_EXPLICIT', type: 'USER_INPUT' })}\n`
  )
  if (proven) {
    writeFileSync(
      join(generated, 'subagents', `child-${index}.json`),
      JSON.stringify({ conversationId: `child-${index}`, state: 'SUBAGENT_STATE_ALIVE' })
    )
  }
  const hook = (conversationId: string, name: string, extra: Record<string, unknown>) =>
    normalizeHookPayload(
      state,
      'antigravity',
      { paneKey, payload: { hook_event_name: name, conversationId, ...extra } },
      'production'
    )
  hook(root, 'PreInvocation', { transcriptPath, lastUserInput: 'Task', modelName: 'model-r' })
  const row = hook(root, 'PreToolUse', { transcriptPath, toolCall: { name: 'send_message' } })
  hook(`child-${index}`, 'PreInvocation', { lastUserInput: '', modelName: 'model-c' })
  if (!row) {
    throw new Error('missing Antigravity row')
  }
  pollAntigravityTranscriptStatus(state, row, await readAntigravityTranscriptPoll(state, paneKey))
  return paneKey
}

function quietPollsIn(paneKey: string, windowMs: number): number {
  let polls = 0
  let delayMs = 1_000
  for (let at = delayMs; at <= windowMs; at += delayMs) {
    polls++
    delayMs =
      nextHookTranscriptPollDelay(state, { source: 'antigravity', delayMs }, paneKey, true) ?? 0
  }
  return polls
}

it.each([100, 1000])(
  'backs %s panes of settled subagents off to one poll per 30 s',
  async (panes) => {
    const keys: string[] = []
    for (let index = 0; index < panes; index++) {
      keys.push(await paneWithSubagent(index, true))
    }
    const unproven = await paneWithSubagent(panes, false)

    expect(keys.reduce((total, key) => total + quietPollsIn(key, 300_000), 0)).toBe(13 * panes)
    expect(quietPollsIn(unproven, 300_000)).toBe(8)
    expect(
      nextHookTranscriptPollDelay(state, { source: 'antigravity', delayMs: 30_000 }, keys[0], false)
    ).toBe(1_000)
  }
)
