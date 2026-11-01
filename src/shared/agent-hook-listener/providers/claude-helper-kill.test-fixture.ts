import { mkdtemp, writeFile, mkdir, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, vi } from 'vitest'
import { createHookListenerState, seedLegacyAgentStatusForTests } from '../listener-state'
import { normalizeHookPayload } from '../../agent-hook-listener'
import { ClaudeHelperKillPoller } from './claude-helper-kill-poller'
import { readClaudeTranscriptChunk } from './claude-transcript-cursor'
import type { AgentHookEventPayload } from '../listener-event'

export let dir: string
export const now = Date.parse('2026-10-29T12:00:00Z')
export const stamp = (offset: number) => new Date(now + offset).toISOString()
export const kill = (offset = 1) =>
  `${JSON.stringify({ type: 'system', subtype: 'agents_killed', timestamp: stamp(offset) })}\n`
export const prompt = (offset: number) =>
  `${JSON.stringify({
    type: 'user',
    timestamp: stamp(offset),
    message: { role: 'user', content: 'Do the work' }
  })}\n`

beforeEach(async () => {
  vi.spyOn(Date, 'now').mockReturnValue(now)
  dir = await mkdtemp(join(tmpdir(), 'claude-helper-kill-'))
})
afterEach(async () => {
  vi.restoreAllMocks()
  await rm(dir, { recursive: true, force: true })
})

export async function pane(shell = false, reader = readClaudeTranscriptChunk, cron = false) {
  const state = createHookListenerState()
  const path = join(dir, 'session.jsonl')
  await writeFile(path, prompt(-20))
  await mkdir(join(dir, 'session', 'subagents'), { recursive: true })
  const child = (id: string) => join(dir, 'session', 'subagents', `agent-${id}.jsonl`)
  await writeFile(child('a123'), prompt(-10))
  let current: AgentHookEventPayload | undefined
  const events: AgentHookEventPayload[] = []
  function post(payload: Record<string, unknown>) {
    const event = normalizeHookPayload(
      state,
      'claude',
      {
        paneKey: 'test-tab:11111111-1111-4111-8111-111111111111',
        env: 'production',
        payload: { session_id: 'session', transcript_path: path, ...payload }
      },
      'production'
    )
    if (!event) {
      throw new Error('hook declined')
    }
    current = event
    seedLegacyAgentStatusForTests(state, event)
    return event
  }
  post({ hook_event_name: 'UserPromptSubmit', prompt: 'work' })
  post({ hook_event_name: 'SubagentStart', agent_id: 'a123' })
  post({
    hook_event_name: 'Stop',
    last_assistant_message: 'READY',
    background_tasks: [
      { id: 'a123', type: 'subagent', status: 'running' },
      ...(shell ? [{ id: 'shell', type: 'local_bash', status: 'running' }] : [])
    ],
    session_crons: cron ? [{ id: 'cron' }] : []
  })
  const publish = vi.fn((event: AgentHookEventPayload) => {
    current = event
    events.push(event)
    seedLegacyAgentStatusForTests(state, event)
  })
  let listening = true
  const poller = new ClaudeHelperKillPoller(
    state,
    { current: () => current, publish, listening: () => listening },
    reader
  )
  poller.schedule(current!)
  return {
    state,
    listen: (value: boolean) => {
      listening = value
      if (value) {
        poller.activate()
      }
    },
    path,
    child,
    post,
    poller,
    publish,
    events,
    row: () => current!,
    replace: (row: AgentHookEventPayload) => {
      current = row
      poller.schedule(row)
    }
  }
}

export async function drain(p: Awaited<ReturnType<typeof pane>>) {
  for (let i = 0; i < 8; i++) {
    await p.poller.poll('test-tab:11111111-1111-4111-8111-111111111111')
  }
}
