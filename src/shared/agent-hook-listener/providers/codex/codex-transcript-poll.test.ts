import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { appendFileSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import type * as Fs from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createHookListenerState, type HookListenerState } from '../../listener-state'
import { seedLegacyAgentStatusForTests } from '../../legacy-agent-status-test-seed'
import { normalizeAndAccept, PANE_KEY } from '../../normalization/agent-hook-listener-test-harness'
import { pollCodexTranscriptStatus, readCodexTranscriptPoll } from './codex-transcript-poll'
import { prefetchCodexHookRolloutReads } from './codex-hook-rollout-prefetch'
import { withPrefetchedRolloutReads } from './codex-rollout-prefetch-scope'

const syncFs = vi.hoisted((): { recording: boolean; calls: string[] } => ({
  recording: false,
  calls: []
}))

// Record every synchronous node:fs call so the poll can prove it never blocks the main thread.
vi.mock('node:fs', async (importOriginal) => {
  const actual = await importOriginal<typeof Fs>()
  const wrapped: Record<string, unknown> = { ...actual }
  for (const [name, exported] of Object.entries(actual)) {
    const value: unknown = exported
    if (name.endsWith('Sync') && typeof value === 'function') {
      wrapped[name] = (...args: unknown[]) => {
        if (syncFs.recording) {
          syncFs.calls.push(name)
        }
        return value(...args)
      }
    }
  }
  return { ...wrapped, default: wrapped }
})

const CHILD_ID = '019fa65f-3144-7151-9c02-cff7a28f316f'

function line(value: unknown): string {
  return `${JSON.stringify(value)}\n`
}

function event(payload: Record<string, unknown>): string {
  return line({ type: 'event_msg', payload })
}

describe('Codex transcript poll', () => {
  let dir: string
  let state: HookListenerState

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'codex-transcript-poll-'))
    state = createHookListenerState()
    syncFs.calls.length = 0
  })

  afterEach(() => {
    syncFs.recording = false
    rmSync(dir, { recursive: true, force: true })
  })

  async function poll(body: unknown) {
    const original = state.lastStatusByPaneKey.get(PANE_KEY)!
    syncFs.recording = true
    const reads = await readCodexTranscriptPoll(state, PANE_KEY)
    const next = pollCodexTranscriptStatus(state, original, body, 'production', reads)
    reads.batch.release()
    syncFs.recording = false
    if (next && next !== original) {
      seedLegacyAgentStatusForTests(state, next)
    }
    return next
  }

  // #43539: a sync open of a rollout being scanned on Windows froze the whole UI for seconds.
  it('tracks parent, child, child identity and turn end without synchronous file I/O', async () => {
    const parentPath = join(dir, 'rollout-parent.jsonl')
    const childPath = join(dir, `rollout-2026-11-17T10-00-00-${CHILD_ID}.jsonl`)
    writeFileSync(parentPath, event({ type: 'task_started', turn_id: 'turn-1' }))
    const hook = {
      hook_event_name: 'PostToolUse',
      session_id: 'root-session',
      turn_id: 'turn-1',
      transcript_path: parentPath,
      tool_name: 'shell'
    }
    normalizeAndAccept(state, 'codex', hook)
    const body = { paneKey: PANE_KEY, payload: hook }

    appendFileSync(
      parentPath,
      event({
        type: 'sub_agent_activity',
        occurred_at_ms: 1234,
        agent_thread_id: CHILD_ID,
        kind: 'started'
      })
    )
    writeFileSync(
      childPath,
      line({ type: 'session_meta', payload: { id: CHILD_ID, agent_nickname: 'Scout' } }) +
        event({ type: 'task_started' })
    )
    expect((await poll(body))?.payload.subagents).toMatchObject([
      { id: CHILD_ID, state: 'working' }
    ])
    // The next polls list the child's directory, read its rollout, then its identity header.
    await poll(body)
    expect((await poll(body))?.payload.subagents).toMatchObject([
      { id: CHILD_ID, description: 'Scout' }
    ])

    appendFileSync(childPath, event({ type: 'task_complete' }))
    appendFileSync(parentPath, event({ type: 'task_complete', turn_id: 'turn-1' }))
    const stop = await poll(body)
    expect(stop?.hookEventName).toBe('Stop')
    expect(stop?.payload.state).toBe('done')
    expect(stop?.payload.subagents).toBeUndefined()
    expect(syncFs.calls).toEqual([])
  })

  it('applies a root hook from rollout reads prefetched off the main thread', async () => {
    const parentPath = join(dir, 'rollout-parent.jsonl')
    writeFileSync(
      parentPath,
      event({ type: 'task_started', turn_id: 'turn-1' }) +
        event({
          type: 'sub_agent_activity',
          occurred_at_ms: 1234,
          agent_thread_id: CHILD_ID,
          kind: 'started'
        })
    )
    const hook = {
      hook_event_name: 'PostToolUse',
      session_id: 'root-session',
      turn_id: 'turn-1',
      transcript_path: parentPath,
      tool_name: 'shell'
    }
    syncFs.recording = true
    const reads = await prefetchCodexHookRolloutReads(state, { paneKey: PANE_KEY, payload: hook })
    const status = withPrefetchedRolloutReads(reads, () => normalizeAndAccept(state, 'codex', hook))
    reads.batch.release()
    syncFs.recording = false
    expect(status?.payload.subagents).toMatchObject([{ id: CHILD_ID, state: 'working' }])
    expect(syncFs.calls).toEqual([])
  })
})
