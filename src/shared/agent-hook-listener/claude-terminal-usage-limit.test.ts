import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, expect, it } from 'vitest'
import { readClaudeTerminalUsageLimit } from './claude-terminal-usage-limit'
import { createHookListenerState } from './listener-state'
import { normalizeAndAccept, CLAUDE_PROMPT_ID } from '../agent-hook-listener-test-harness'

const NOW = 1_793_752_550_000
const RESET_SECONDS = 1_793_756_137
const expected = { sessionId: 'session', promptId: 'prompt' }
const directories: string[] = []

afterEach(() => {
  for (const directory of directories.splice(0)) {
    rmSync(directory, { recursive: true, force: true })
  }
})

function read(rows: Record<string, unknown>[]) {
  const directory = mkdtempSync(join(tmpdir(), 'claude-terminal-quota-'))
  directories.push(directory)
  const path = join(directory, 'transcript.jsonl')
  writeFileSync(path, `${rows.map((row) => JSON.stringify(row)).join('\n')}\n`)
  return readClaudeTerminalUsageLimit(path, expected, NOW)
}

const root = {
  type: 'user',
  uuid: 'user',
  parentUuid: null,
  isSidechain: false,
  sessionId: 'session',
  promptId: 'prompt',
  message: { role: 'user', content: 'Finish the task' }
}

// Source-shaped typed branch; the recorded real-CLI 429 lacked apiError and is tested separately.
const quota = {
  type: 'assistant',
  uuid: 'quota',
  parentUuid: 'user',
  isSidechain: false,
  sessionId: 'session',
  error: 'rate_limit',
  apiError: 'usage_limit_reached',
  apiErrorParams: {
    rate_limit_info: { status: 'rejected', rateLimitType: 'five_hour', resetsAt: RESET_SECONDS }
  }
}

it('attributes a camelCase typed quota row without assistant promptId through its parent chain', () => {
  expect(
    read([
      root,
      { ...quota, uuid: 'earlier', apiError: undefined },
      {
        ...root,
        uuid: 'tool-result',
        parentUuid: 'earlier',
        message: { content: [{ type: 'tool_result', tool_use_id: 'tool' }] }
      },
      { ...quota, parentUuid: 'tool-result' }
    ])
  ).toEqual({
    messageId: 'quota',
    usageLimit: { window: 'session', resetsAt: RESET_SECONDS * 1000 }
  })
})

it('does not classify the recorded generic 429 as quota from its text or status', () => {
  expect(
    read([
      root,
      {
        ...quota,
        apiError: undefined,
        apiErrorParams: undefined,
        apiErrorStatus: 429,
        isApiErrorMessage: true,
        message: { content: [{ type: 'text', text: 'usage limit reached' }] }
      }
    ])
  ).toBeUndefined()
})

it('never carries a quota through a newer root input, including native meta input without promptId', () => {
  for (const next of [
    { ...root, uuid: 'next', promptId: 'next' },
    { ...root, uuid: 'native', promptId: undefined, isMeta: true }
  ]) {
    expect(read([root, quota, next])).toBeUndefined()
  }
  expect(read([root, { ...quota, parentUuid: 'unrelated' }])).toBeUndefined()
  expect(read([root, { ...quota, isSidechain: true }])).toBeUndefined()
})

it('retains typed quota without inventing a reset from missing or overage-enabled metadata', () => {
  expect(read([root, { ...quota, apiErrorParams: undefined }])?.usageLimit).toEqual({})
  expect(
    read([
      root,
      {
        ...quota,
        apiErrorParams: {
          rate_limit_info: { ...quota.apiErrorParams.rate_limit_info, isUsingOverage: true }
        }
      }
    ])?.usageLimit
  ).toEqual({})
})

it('publishes root quota through child-held status and cancels it on compact without settling work', () => {
  const sessionId = '44444444-4444-4444-8444-444444444444'
  const directory = mkdtempSync(join(tmpdir(), 'claude-terminal-quota-hook-'))
  directories.push(directory)
  const transcriptPath = join(directory, 'transcript.jsonl')
  writeFileSync(
    transcriptPath,
    `${[
      { ...root, sessionId, promptId: CLAUDE_PROMPT_ID },
      { ...quota, sessionId, apiErrorParams: undefined }
    ]
      .map((row) => JSON.stringify(row))
      .join('\n')}\n`
  )
  const state = createHookListenerState()
  const hook = (payload: Record<string, unknown>) =>
    normalizeAndAccept(state, 'claude', {
      session_id: sessionId,
      prompt_id: CLAUDE_PROMPT_ID,
      transcript_path: transcriptPath,
      ...payload
    })
  hook({ hook_event_name: 'UserPromptSubmit', prompt: 'Finish the task' })
  expect(
    hook({ hook_event_name: 'StopFailure', error: 'rate_limit' })?.payload.mainAgent
  ).toMatchObject({
    state: 'done',
    outcome: 'failure',
    usageLimit: {}
  })
  const child = hook({ hook_event_name: 'SubagentStart', agent_id: 'child', agent_type: 'Explore' })
  expect(child?.payload.mainAgent?.usageLimit).toEqual({})
  const compact = hook({ hook_event_name: 'SessionStart', source: 'compact' })
  expect(compact?.payload.mainAgent?.usageLimit).toBeUndefined()
  expect(compact?.payload.mainAgent?.state).toBe('done')
  expect(
    hook({ hook_event_name: 'UserPromptSubmit', prompt: 'New task' })?.payload.mainAgent
  ).toMatchObject({
    state: 'working'
  })
})
