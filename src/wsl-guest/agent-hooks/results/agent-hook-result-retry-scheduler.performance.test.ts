import type * as FsPromises from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { expect, it, vi } from 'vitest'
import { seedLegacyAgentStatusForTests } from '../../../shared/agent-hook-listener/legacy-agent-status-test-seed'
import { createHookListenerState } from '../../../shared/agent-hook-listener/listener-state'
import { normalizeHookPayload } from '../../../shared/agent-hook-listener/normalization/normalize-hook-payload'
import * as transcriptPoll from '../../../shared/agent-hook-listener/providers/codex/codex-transcript-poll'
import { makePaneKey } from '../../../shared/workspace-layout/stable-pane-id'
import { AgentHookResultRetryScheduler } from './agent-hook-result-retry-scheduler'

const fs = vi.hoisted(() => {
  const pending: (() => void)[] = []
  return { rollouts: new Map<string, Buffer>(), stalled: true, pending }
})

vi.mock('node:fs/promises', async (importOriginal) => {
  const actual = await importOriginal<typeof FsPromises>()
  return {
    ...actual,
    stat: async (...args: Parameters<typeof actual.stat>) => {
      const rollout = fs.rollouts.get(String(args[0]))
      if (!rollout) {
        return actual.stat(...args)
      }
      if (fs.stalled) {
        await new Promise<void>((resolve) => fs.pending.push(resolve))
      }
      return { isFile: () => true, size: rollout.length }
    },
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

// #46385: a full native stall must stop the production read/apply/rearm loop until capacity returns.
it.each([100, 1000])(
  'parks %s live Codex polls and recovers only surviving panes',
  async (panes) => {
    vi.useFakeTimers({ toFake: ['Date', 'setTimeout', 'clearTimeout', 'performance'] })
    vi.spyOn(console, 'warn').mockImplementation(() => {})
    fs.stalled = true
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
    const read = vi.spyOn(transcriptPoll, 'withCodexTranscriptPoll')
    const apply = vi.spyOn(transcriptPoll, 'pollCodexTranscriptStatus')
    const schedule = vi.spyOn(scheduler, 'scheduleTranscriptPoll')
    const rows = Array.from({ length: panes }, (_, index) => ({
      paneKey: makePaneKey(`tab-${index}`, '11111111-1111-4111-8111-111111111111'),
      path: join(tmpdir(), 'orca-transcript-ownership-test', `rollout-${index}.jsonl`)
    }))
    const completed = Buffer.from(
      '{"type":"event_msg","payload":{"type":"task_complete","turn_id":"turn-1"}}\n'
    )
    try {
      for (const { paneKey, path } of rows) {
        fs.rollouts.set(path, completed)
        const body = {
          paneKey,
          payload: {
            hook_event_name: 'PostToolUse',
            session_id: paneKey,
            turn_id: 'turn-1',
            transcript_path: path,
            tool_name: 'shell'
          }
        }
        const row = normalizeHookPayload(state, 'codex', body, 'production')
        if (!row) {
          throw new Error(`Could not seed Codex status for ${paneKey}`)
        }
        seedLegacyAgentStatusForTests(state, row)
        scheduler.scheduleTranscriptPoll('codex', body, row)
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
      scheduler.clearAll()
      fs.stalled = false
      for (const resume of fs.pending.splice(0)) {
        resume()
      }
      await new Promise<void>((resolve) => setImmediate(resolve))
      fs.rollouts.clear()
      vi.restoreAllMocks()
      vi.useRealTimers()
    }
  }
)
