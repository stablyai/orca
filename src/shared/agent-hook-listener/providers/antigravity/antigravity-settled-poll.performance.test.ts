import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import * as fs from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { createHookListenerState } from '../../listener-state'
import { normalizeHookPayload } from '../../normalization/normalize-hook-payload'
import {
  nextHookTranscriptPollDelay,
  shouldPollHookTranscript,
  transcriptPollUpdate
} from '../../transcript-poll-policy'
import { AgentTranscriptPollScheduler } from '../../transcripts/agent-transcript-poll-scheduler'
import { withHookTranscriptPoll } from '../../transcripts/hook-transcript-poll-reads'
import type * as SubagentRoster from './antigravity-subagent-roster'
import { reconcileAntigravityActiveSubagents } from './antigravity-subagent-roster'
import { pollAntigravityTranscriptStatus } from './antigravity-transcript-poll'
import type { AgentHookEventPayload } from '../../listener-event'

vi.mock('node:fs/promises', async (original) => {
  const actual = await original<typeof fs>()
  return { ...actual, open: vi.fn(actual.open), stat: vi.fn(actual.stat) }
})

vi.mock('./antigravity-subagent-roster', async (original) => {
  const actual = await original<typeof SubagentRoster>()
  return {
    ...actual,
    reconcileAntigravityActiveSubagents: vi.fn(actual.reconcileAntigravityActiveSubagents)
  }
})

let dir: string
let state: ReturnType<typeof createHookListenerState>

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'agy-settled-poll-'))
  state = createHookListenerState()
})

afterEach(() => {
  vi.useRealTimers()
  rmSync(dir, { recursive: true, force: true })
})

function paneWithSubagents(index: number, count: number) {
  const paneKey = `tab-${index}:${index.toString(16).padStart(8, '0')}-0000-4000-8000-000000000000`
  const root = `root-${index}`
  const generated = join(dir, root, '.system_generated')
  mkdirSync(join(generated, 'logs'), { recursive: true })
  mkdirSync(join(generated, 'subagents'), { recursive: true })
  const transcriptPath = join(generated, 'logs', 'transcript.jsonl')
  writeFileSync(transcriptPath, '{"source":"USER_EXPLICIT","type":"USER_INPUT"}\n')
  const normalize = (conversationId: string, name: string, extra: Record<string, unknown>) =>
    normalizeHookPayload(
      state,
      'antigravity',
      { paneKey, payload: { hook_event_name: name, conversationId, ...extra } },
      'production'
    )
  const start = normalize(root, 'PreInvocation', {
    transcriptPath,
    lastUserInput: 'Task',
    modelName: 'model-r'
  })
  if (!start) {
    throw new Error('Missing root row')
  }
  const children = Array.from({ length: count }, (_, i) => `child-${i}`)
  for (const conversationId of children) {
    writeFileSync(
      join(generated, 'subagents', `${conversationId}.json`),
      JSON.stringify({ conversationId, state: 'SUBAGENT_STATE_ALIVE' })
    )
    normalize(conversationId, 'PreInvocation', { lastUserInput: '', modelName: 'model-c' })
    normalize(conversationId, 'PreToolUse', { toolCall: { name: 'ask_question', args: {} } })
  }
  return {
    paneKey,
    start,
    stopChildren: () => {
      for (const id of children) {
        normalize(id, 'Stop', { fullyIdle: true })
      }
    },
    stop: () => normalize(root, 'Stop', { transcriptPath, fullyIdle: true })
  }
}

it.each([
  [100, 1],
  [100, 10],
  [1000, 1],
  [1000, 10]
])(
  'probes %s quiet panes with %s live children without rebuilding their rows',
  async (panes, count) => {
    vi.useFakeTimers({ toFake: ['Date', 'setTimeout', 'clearTimeout', 'performance'] })
    const rows = new Map<string, AgentHookEventPayload>()
    const polls: Promise<void>[] = []
    let callbacks = 0
    let publications = 0
    const scheduler = new AgentTranscriptPollScheduler<number>(1000, (key, delayMs, wanted) => {
      callbacks++
      const original = rows.get(key)!
      const poll = withHookTranscriptPoll(state, key, 'antigravity', wanted, (reads) => {
        const result = pollAntigravityTranscriptStatus(state, original, reads.antigravity)
        if (!result) {
          return
        }
        const update = transcriptPollUpdate('antigravity', original, result)
        if (update) {
          rows.set(key, update)
          publications++
        }
        if (shouldPollHookTranscript(state, 'antigravity', update ?? original)) {
          const delay = nextHookTranscriptPollDelay(
            state,
            { source: 'antigravity', delayMs },
            key,
            !update,
            reads.antigravity?.nextPoll
          )!
          scheduler.schedule(key, delay, undefined, delay)
        }
      })
      polls.push(poll)
      return poll
    })
    const runDue = async (elapsed: number) => {
      await vi.advanceTimersByTimeAsync(elapsed)
      await Promise.all(polls.splice(0))
    }
    const entries = Array.from({ length: panes }, (_, index) => paneWithSubagents(index, count))
    for (const { paneKey, start } of entries) {
      rows.set(paneKey, start)
      scheduler.schedule(paneKey, 1000)
    }
    await runDue(1000)
    expect(publications).toBe(panes)
    expect([...rows.values()].every((row) => row.payload.subagents?.length === count)).toBe(true)

    callbacks = publications = 0
    vi.mocked(fs.stat).mockClear()
    vi.mocked(fs.open).mockClear()
    vi.mocked(reconcileAntigravityActiveSubagents).mockClear()
    await runDue(1000)
    await runDue(29_999)
    expect(callbacks).toBe(panes)
    expect(fs.stat).toHaveBeenCalledTimes(panes * (count + 1))
    await runDue(1)
    expect(callbacks).toBe(2 * panes)
    expect(fs.stat).toHaveBeenCalledTimes(2 * panes * (count + 1))
    expect(fs.open).not.toHaveBeenCalled()
    expect(reconcileAntigravityActiveSubagents).not.toHaveBeenCalled()
    expect(publications).toBe(0)

    for (const { paneKey, stopChildren } of entries) {
      stopChildren()
      scheduler.schedule(paneKey, 1000, undefined, 1000)
    }
    await runDue(1000)
    expect(publications).toBe(panes)
    expect([...rows.values()].every((row) => row.payload.subagents === undefined)).toBe(true)
    const afterChildren = callbacks
    await runDue(60_000)
    expect(callbacks).toBe(afterChildren)
    for (const { stop } of entries) {
      const done = stop()!
      expect(done.payload.state).toBe('done')
      expect(shouldPollHookTranscript(state, 'antigravity', done)).toBe(false)
    }
    expect(
      shouldPollHookTranscript(state, 'antigravity', {
        paneKey: 'never-active',
        connectionId: null,
        payload: { state: 'done', prompt: '', agentType: 'antigravity' }
      })
    ).toBe(false)
    await runDue(60_000)
    expect(callbacks).toBe(afterChildren)
    scheduler.clearAll()
  }
)
