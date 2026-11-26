import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, expect, it } from 'vitest'
import { createHookListenerState } from '../../listener-state'
import { normalizeHookPayload } from '../../normalization/normalize-hook-payload'
import { upsertBoundedAgentHookStatus } from '../../state/agent-hook-status-cache'

const PANE_KEY = 'tab-1:11111111-1111-4111-8111-111111111111'
const tempDirs: string[] = []

afterEach(() => {
  for (const dir of tempDirs.splice(0)) {
    rmSync(dir, { recursive: true, force: true })
  }
})

function transcript(firstRecord: Record<string, unknown>): string {
  const dir = mkdtempSync(join(tmpdir(), 'droid-sub-'))
  tempDirs.push(dir)
  const path = join(dir, 'session.jsonl')
  writeFileSync(path, `${JSON.stringify({ type: 'session_start', ...firstRecord })}\n`)
  return path
}

/** Normalizes a hook and commits its row, as the listener does before the next hook arrives. */
function post(state: ReturnType<typeof createHookListenerState>, payload: Record<string, unknown>) {
  const row = normalizeHookPayload(
    state,
    'droid',
    { paneKey: PANE_KEY, env: 'env-1', payload: JSON.stringify(payload) },
    'env-1'
  )
  if (row) {
    upsertBoundedAgentHookStatus(state, row)
  }
  return row
}

function startRootTurn(state: ReturnType<typeof createHookListenerState>) {
  post(state, {
    hook_event_name: 'UserPromptSubmit',
    session_id: 'root-1',
    transcript_path: transcript({ id: 'root-1' }),
    prompt: 'go'
  })
  expect(state.lastStatusByPaneKey.get(PANE_KEY)).toMatchObject({
    providerSession: { id: 'root-1' },
    payload: { state: 'working', prompt: 'go' }
  })
}

it("keeps the pane on its root session while a Droid Task worker's hooks arrive", () => {
  const state = createHookListenerState()
  startRootTurn(state)
  const workerTranscript = transcript({ id: 'worker-1', callingSessionId: 'root-1' })

  expect(
    post(state, {
      hook_event_name: 'SessionStart',
      session_id: 'worker-1',
      transcript_path: workerTranscript
    })
  ).toBeNull()
  expect(
    post(state, {
      hook_event_name: 'UserPromptSubmit',
      session_id: 'worker-1',
      transcript_path: workerTranscript,
      prompt: 'reply PONG'
    })
  ).toBeNull()
  // Known worker: no transcript_path needed; its tool activity keeps the root's turn working.
  expect(
    post(state, { hook_event_name: 'PostToolUse', session_id: 'worker-1', tool_name: 'Read' })
  ).toMatchObject({
    providerSession: { id: 'root-1' },
    payload: { state: 'working', prompt: 'go' }
  })
  expect(
    post(state, {
      hook_event_name: 'Notification',
      session_id: 'worker-1',
      message: 'Droid is waiting for your input'
    })
  ).toBeNull()
  expect(
    post(state, {
      hook_event_name: 'Stop',
      session_id: 'worker-1',
      transcript_path: workerTranscript
    })
  ).toBeNull()
  expect(state.lastStatusByPaneKey.get(PANE_KEY)).toMatchObject({
    providerSession: { id: 'root-1' },
    payload: { state: 'working', prompt: 'go' }
  })

  expect(post(state, { hook_event_name: 'Stop', session_id: 'root-1' })).toMatchObject({
    providerSession: { id: 'root-1' },
    payload: { state: 'done', prompt: 'go' }
  })
})

it('lets a new root Droid session take over the pane', () => {
  const state = createHookListenerState()
  startRootTurn(state)

  expect(
    post(state, {
      hook_event_name: 'UserPromptSubmit',
      session_id: 'root-2',
      transcript_path: transcript({ id: 'root-2' }),
      prompt: 'next'
    })
  ).toMatchObject({ providerSession: { id: 'root-2' }, payload: { state: 'working' } })
  expect(post(state, { hook_event_name: 'Stop', session_id: 'root-2' })).toMatchObject({
    payload: { state: 'done', prompt: 'next' }
  })
})

it('reports a background Droid Task worker that outlives the root turn as the root', () => {
  const state = createHookListenerState()
  startRootTurn(state)
  const workerTranscript = transcript({ id: 'worker-1', callingSessionId: 'root-1' })
  const worker = { session_id: 'worker-1', transcript_path: workerTranscript }
  post(state, { hook_event_name: 'SessionStart', ...worker })
  expect(post(state, { hook_event_name: 'Stop', session_id: 'root-1' })).toMatchObject({
    payload: { state: 'done' }
  })

  const expected = [
    [{ hook_event_name: 'PreToolUse', tool_name: 'AskUser' }, 'waiting'],
    [{ hook_event_name: 'PostToolUse', tool_name: 'AskUser' }, 'working'],
    [{ hook_event_name: 'Notification', message: 'Droid needs your permission' }, 'waiting'],
    [{ hook_event_name: 'PostToolUse', tool_name: 'Edit' }, 'working'],
    [{ hook_event_name: 'Stop' }, 'done']
  ] as const
  for (const [hook, rowState] of expected) {
    expect(post(state, { ...hook, ...worker })).toMatchObject({
      providerSession: { id: 'root-1' },
      payload: { state: rowState, prompt: 'go' }
    })
  }
})

it('settles background Droid Task workers that run after the root turn ended', () => {
  const state = createHookListenerState()
  startRootTurn(state)
  post(state, { hook_event_name: 'Stop', session_id: 'root-1' })
  const workerA = {
    session_id: 'worker-a',
    transcript_path: transcript({ id: 'worker-a', callingSessionId: 'root-1' })
  }
  const workerB = {
    session_id: 'worker-b',
    transcript_path: transcript({ id: 'worker-b', callingSessionId: 'worker-a' })
  }

  post(state, { hook_event_name: 'SessionStart', ...workerA })
  post(state, { hook_event_name: 'UserPromptSubmit', ...workerA, prompt: 'reply PONG' })
  post(state, { hook_event_name: 'PostToolUse', ...workerA, tool_name: 'Read' })
  expect(post(state, { hook_event_name: 'Stop', ...workerA })).toMatchObject({
    providerSession: { id: 'root-1' },
    payload: { state: 'done' }
  })
  post(state, { hook_event_name: 'UserPromptSubmit', ...workerA, prompt: 'again' })
  post(state, { hook_event_name: 'PostToolUse', ...workerA, tool_name: 'Task' })
  post(state, { hook_event_name: 'SessionStart', ...workerB })
  post(state, { hook_event_name: 'UserPromptSubmit', ...workerB, prompt: 'nested' })
  post(state, { hook_event_name: 'PostToolUse', ...workerB, tool_name: 'Read' })
  post(state, { hook_event_name: 'Stop', ...workerB })
  post(state, { hook_event_name: 'PostToolUse', ...workerA, tool_name: 'Task' })
  post(state, { hook_event_name: 'Stop', ...workerA })
  expect(state.lastStatusByPaneKey.get(PANE_KEY)).toMatchObject({
    providerSession: { id: 'root-1' },
    payload: { state: 'done' }
  })
})

it('still reports a Droid sub-session that has no root row to defer to', () => {
  const state = createHookListenerState()
  const subTranscript = transcript({ id: 'sub-1', callingSessionId: 'elsewhere' })

  expect(
    post(state, {
      hook_event_name: 'UserPromptSubmit',
      session_id: 'sub-1',
      transcript_path: subTranscript,
      prompt: 'go'
    })
  ).toMatchObject({ payload: { state: 'working', prompt: 'go' } })
  expect(
    post(state, { hook_event_name: 'Stop', session_id: 'sub-1', transcript_path: subTranscript })
  ).toMatchObject({ payload: { state: 'done' } })
})
