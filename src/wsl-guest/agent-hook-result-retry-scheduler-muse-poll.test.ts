import { afterEach, expect, it, vi } from 'vitest'
import { appendFileSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { AgentHookResultRetryScheduler } from './agent-hook-result-retry-scheduler'
import { createHookListenerState } from '../shared/agent-hook-listener/listener-state'
import { normalizeHookPayload } from '../shared/agent-hook-listener/normalization/normalize-hook-payload'
import { upsertBoundedAgentHookStatus } from '../shared/agent-hook-listener/state/agent-hook-status-cache'
import { makePaneKey } from '../shared/workspace-layout/stable-pane-id'

const PANE_KEY = makePaneKey('tab-1', '11111111-1111-4111-8111-111111111111')
const SESSION_ID = '01a0caa3-0e77-7d41-bad7-46283a45633d'

let dataHome: string | undefined
afterEach(() => {
  vi.useRealTimers()
  vi.unstubAllEnvs()
  if (dataHome) {
    rmSync(dataHome, { recursive: true, force: true })
  }
})

function createSessionLog(home: string): string {
  const date = new Date(Number.parseInt(SESSION_ID.replace(/-/g, '').slice(0, 12), 16))
  const dir = join(
    home,
    'muse',
    'sessions',
    String(date.getFullYear()),
    String(date.getMonth() + 1).padStart(2, '0'),
    String(date.getDate()).padStart(2, '0'),
    SESSION_ID
  )
  mkdirSync(dir, { recursive: true })
  const logPath = join(dir, 'session.jsonl')
  writeFileSync(logPath, '')
  return logPath
}

// A killed or quiet session writes no hook, so the poll backs off; a hook the listener ignores
// (PermissionRequest) must still restore the 1s poll so a log-only question shows promptly.
it('an ignored Muse hook after a quiet spell surfaces a log-only question within a second', async () => {
  vi.useFakeTimers()
  dataHome = mkdtempSync(join(tmpdir(), 'relay-muse-poll-'))
  vi.stubEnv('XDG_DATA_HOME', dataHome)
  const logPath = createSessionLog(dataHome)
  const state = createHookListenerState()
  const store = (event: NonNullable<ReturnType<typeof state.lastStatusByPaneKey.get>>) => {
    upsertBoundedAgentHookStatus(state, event)
    return state.lastStatusByPaneKey.get(event.paneKey)
  }
  const scheduler = new AgentHookResultRetryScheduler({
    state,
    env: 'production',
    isListening: () => true,
    applyEvent: (event) => store(event)
  })
  const body = {
    paneKey: PANE_KEY,
    tabId: 'tab-1',
    worktreeId: 'wt-1',
    payload: {
      hook_event_name: 'UserPromptSubmit',
      prompt: 'ask my favorite color',
      session_id: SESSION_ID,
      turn_id: 'e495d1a5-59aa-47b4-8efb-a1bd75509afc',
      cwd: '/tmp/ws'
    }
  }
  const hook = normalizeHookPayload(state, 'muse', body, 'production')
  const stored = hook && store(hook)
  if (!stored) {
    throw new Error('missing Muse hook row')
  }
  scheduler.scheduleTranscriptPoll('muse', body, stored)

  await vi.advanceTimersByTimeAsync(31 * 60_000)
  appendFileSync(
    logPath,
    `${JSON.stringify({
      payload: {
        kind: 'run',
        event: {
          kind: 'user_input_prompt_requested',
          prompt_id: '01a0caa3-a25a-7810-8229-4de04b2e7ca3',
          questions: [{ id: 'fav_color', question: 'What is your favorite color?' }]
        }
      }
    })}\n`
  )
  scheduler.rearmIgnoredMuseHook({
    ...body,
    payload: { ...body.payload, hook_event_name: 'PermissionRequest' }
  })
  await vi.advanceTimersByTimeAsync(1_000)
  expect(state.lastStatusByPaneKey.get(PANE_KEY)?.payload.state).toBe('waiting')
  scheduler.clearAll()
})
