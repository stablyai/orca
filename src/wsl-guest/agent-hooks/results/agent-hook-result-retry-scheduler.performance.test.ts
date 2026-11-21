import type * as FsPromises from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { basename, dirname, join } from 'node:path'
import { expect, it, vi } from 'vitest'
import { seedLegacyAgentStatusForTests } from '../../../shared/agent-hook-listener/legacy-agent-status-test-seed'
import { createHookListenerState } from '../../../shared/agent-hook-listener/listener-state'
import { normalizeHookPayload } from '../../../shared/agent-hook-listener/normalization/normalize-hook-payload'
import * as transcriptPoll from '../../../shared/agent-hook-listener/providers/codex/codex-transcript-poll'
import { makePaneKey } from '../../../shared/workspace-layout/stable-pane-id'
import { AgentHookResultRetryScheduler } from './agent-hook-result-retry-scheduler'

const fs = vi.hoisted(() => {
  const pending: (() => void)[] = []
  return {
    rollouts: new Map<string, Buffer>(),
    directories: new Map<string, string[]>(),
    stalled: true,
    stalledPaths: new Set<string>(),
    pending
  }
})

vi.mock('node:fs/promises', async (importOriginal) => {
  const actual = await importOriginal<typeof FsPromises>()
  return {
    ...actual,
    stat: async (...args: Parameters<typeof actual.stat>) => {
      const path = String(args[0])
      const rollout = fs.rollouts.get(path)
      if (!rollout) {
        return actual.stat(...args)
      }
      if (fs.stalled || fs.stalledPaths.has(path)) {
        await new Promise<void>((resolve) => fs.pending.push(resolve))
      }
      return { isFile: () => true, size: rollout.length }
    },
    readdir: async (...args: Parameters<typeof actual.readdir>) =>
      fs.directories.get(String(args[0])) ?? actual.readdir(...args),
    open: async (...args: Parameters<typeof actual.open>) => {
      const rollout = fs.rollouts.get(String(args[0]))
      if (!rollout) {
        return actual.open(...args)
      }
      return {
        read: async (buffer: Buffer, offset: number, length: number, position: number) => ({
          bytesRead: rollout.copy(buffer, offset, position, position + length)
        }),
        close: async () => {}
      }
    }
  }
})

const completed = Buffer.from(
  '{"type":"event_msg","payload":{"type":"task_complete","turn_id":"turn-1"}}\n'
)

function transcriptPath(id: string): string {
  return join(tmpdir(), 'orca-transcript-ownership-test', `rollout-${id}.jsonl`)
}

function paneKey(id: string): string {
  return makePaneKey(`tab-${id}`, '11111111-1111-4111-8111-111111111111')
}

function transcriptPollHost() {
  const state = createHookListenerState()
  const published = new Map<string, string>()
  const scheduler = new AgentHookResultRetryScheduler({
    state,
    env: 'production',
    isListening: () => true,
    applyEvent: (row) => {
      seedLegacyAgentStatusForTests(state, row)
      published.set(row.paneKey, row.payload.state)
      return state.lastStatusByPaneKey.get(row.paneKey)
    }
  })
  const schedule = (key: string, path: string) => {
    const body = {
      paneKey: key,
      payload: {
        hook_event_name: 'PostToolUse',
        session_id: key,
        turn_id: 'turn-1',
        transcript_path: path,
        tool_name: 'shell'
      }
    }
    const row = normalizeHookPayload(state, 'codex', body, 'production')
    if (!row) {
      throw new Error(`Could not seed Codex status for ${key}`)
    }
    seedLegacyAgentStatusForTests(state, row)
    scheduler.scheduleTranscriptPoll('codex', body, row)
  }
  return { published, schedule, scheduler, state }
}

async function clearPolls(scheduler: AgentHookResultRetryScheduler): Promise<void> {
  scheduler.clearAll()
  fs.stalled = false
  fs.stalledPaths.clear()
  for (const resume of fs.pending.splice(0)) {
    resume()
  }
  await new Promise<void>((resolve) => setImmediate(resolve))
  fs.rollouts.clear()
  fs.directories.clear()
  vi.restoreAllMocks()
  vi.useRealTimers()
}

// #46385: a full native stall must stop the production read/apply/rearm loop until capacity returns.
it.each([100, 1000])(
  'parks %s live Codex polls and recovers only surviving panes',
  async (panes) => {
    vi.useFakeTimers({ toFake: ['Date', 'setTimeout', 'clearTimeout', 'performance'] })
    vi.spyOn(console, 'warn').mockImplementation(() => {})
    fs.stalled = true
    const { published, schedule: startPoll, scheduler } = transcriptPollHost()
    const read = vi.spyOn(transcriptPoll, 'withCodexTranscriptPoll')
    const apply = vi.spyOn(transcriptPoll, 'pollCodexTranscriptStatus')
    const schedule = vi.spyOn(scheduler, 'scheduleTranscriptPoll')
    const rows = Array.from({ length: panes }, (_, index) => ({
      paneKey: paneKey(String(index)),
      path: transcriptPath(String(index))
    }))
    try {
      for (const { paneKey, path } of rows) {
        fs.rollouts.set(path, completed)
        startPoll(paneKey, path)
      }
      await vi.advanceTimersByTimeAsync(21_000)
      expect(fs.pending).toHaveLength(3)
      expect(read).toHaveBeenCalledTimes(panes)
      expect(apply).toHaveBeenCalledTimes(panes)
      expect(schedule).toHaveBeenCalledTimes(2 * panes)
      expect(published.size).toBe(0)

      await vi.advanceTimersByTimeAsync(30_000)
      expect(read).toHaveBeenCalledTimes(panes)
      expect(apply).toHaveBeenCalledTimes(panes)
      expect(schedule).toHaveBeenCalledTimes(2 * panes)

      for (const { paneKey } of rows.slice(0, 3)) {
        scheduler.clearTranscriptPoll(paneKey)
      }
      fs.stalled = false
      fs.pending.shift()!()
      await vi.advanceTimersByTimeAsync(5_000)

      expect(read).toHaveBeenCalledTimes(2 * panes - 3)
      expect(apply).toHaveBeenCalledTimes(2 * panes - 3)
      expect(published).toEqual(new Map(rows.slice(3).map(({ paneKey }) => [paneKey, 'done'])))
    } finally {
      await clearPolls(scheduler)
    }
  }
)

// #46385: one native path must not exhaust the pool as its poll caller expires.
it.each([100, 1000])(
  'keeps %s healthy peers progressing while one rollout stalls across caller deadlines',
  async (peers) => {
    vi.useFakeTimers({ toFake: ['Date', 'setTimeout', 'clearTimeout', 'performance'] })
    fs.stalled = false
    const a = paneKey('stalled')
    const surviving = paneKey('surviving')
    const retired = paneKey('retired')
    const path = transcriptPath('stalled')
    const replacement = transcriptPath('replacement')
    fs.stalledPaths.add(path)
    fs.rollouts.set(path, completed)
    fs.rollouts.set(replacement, completed)
    const { published, schedule, scheduler } = transcriptPollHost()
    const read = vi.spyOn(transcriptPoll, 'withCodexTranscriptPoll')
    const apply = vi.spyOn(transcriptPoll, 'pollCodexTranscriptStatus')
    const readsOf = (key: string) => read.mock.calls.filter((call) => call[1] === key).length
    const appliesTo = (key: string) =>
      apply.mock.calls.filter((call) => call[1].paneKey === key).length

    try {
      schedule(a, path)
      await vi.advanceTimersByTimeAsync(1_000)
      schedule(surviving, path)
      schedule(retired, path)

      // Put fresh, live turns through the same pool before and after the stalled caller's deadline.
      const healthy = new Map<string, string>()
      for (let window = 0; window < 3; window++) {
        for (let index = window; index < peers; index += 3) {
          const key = paneKey(`peer-${index}`)
          const peerPath = transcriptPath(`peer-${index}`)
          fs.rollouts.set(peerPath, completed)
          schedule(key, peerPath)
          healthy.set(key, 'done')
        }
        await vi.advanceTimersByTimeAsync(25_000)
        expect(published).toEqual(healthy)
        expect(fs.pending).toHaveLength(1)
        expect(readsOf(a)).toBe(1)
        expect(appliesTo(a)).toBe(1)
      }
      expect(readsOf(surviving)).toBe(0)
      expect(readsOf(retired)).toBe(0)

      scheduler.clearTranscriptPoll(retired)
      schedule(a, replacement)
      await vi.advanceTimersByTimeAsync(5_000)
      healthy.set(a, 'done')
      expect(published).toEqual(healthy)
      expect(readsOf(a)).toBe(2)

      fs.stalledPaths.delete(path)
      fs.pending.shift()!()
      await vi.advanceTimersByTimeAsync(5_000)
      healthy.set(surviving, 'done')
      expect(published).toEqual(healthy)
      expect(readsOf(surviving)).toBe(1)
      expect(readsOf(retired)).toBe(0)
      expect(readsOf(a)).toBe(2)
    } finally {
      await clearPolls(scheduler)
    }
  }
)

// #46385: a stalled parent must not block a child's completion from its own rollout.
it('keeps a known child progressing while its parent rollout is stalled', async () => {
  vi.useFakeTimers({ toFake: ['Date', 'setTimeout', 'clearTimeout', 'performance'] })
  fs.stalled = false
  const { schedule, scheduler, state } = transcriptPollHost()
  const key = paneKey('parent')
  const parent = transcriptPath('parent')
  const childId = 'child-1'
  const child = transcriptPath(childId)
  const status = () => state.lastStatusByPaneKey.get(key)?.payload
  fs.directories.set(dirname(parent), [basename(child)])
  fs.rollouts.set(
    parent,
    Buffer.from(
      '{"type":"event_msg","payload":{"type":"sub_agent_activity","agent_thread_id":"child-1","kind":"started","agent_path":"/root/scout"}}\n'
    )
  )
  fs.rollouts.set(child, Buffer.alloc(0))

  try {
    schedule(key, parent)
    await vi.advanceTimersByTimeAsync(2_000)
    expect(status()?.subagents).toMatchObject([{ id: childId, state: 'working' }])

    fs.stalledPaths.add(parent)
    fs.rollouts.set(child, completed)
    await vi.advanceTimersByTimeAsync(25_000)

    expect(status()?.state).toBe('working')
    expect(status()?.subagents).toBeUndefined()
    expect(fs.pending).toHaveLength(1)
  } finally {
    await clearPolls(scheduler)
  }
})
