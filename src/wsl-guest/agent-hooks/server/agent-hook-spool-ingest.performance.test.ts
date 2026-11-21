import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, expect, it, vi } from 'vitest'
import type * as Spool from '../../../shared/agent-hook-listener/transport/agent-hook-spool'
import { makePaneKey } from '../../../shared/workspace-layout/stable-pane-id'
import { AgentTranscriptPollScheduler } from '../../../shared/agent-hook-listener/transcripts/agent-transcript-poll-scheduler'
import { RelayAgentHookServer } from './agent-hook-server'
import * as spoolIngest from './agent-hook-spool-ingest'

const replay = vi.hoisted(() => ({
  consume: async (_options: Spool.SpoolDrainOptions): Promise<number> => 0
}))

vi.mock(
  '../../../shared/agent-hook-listener/transport/agent-hook-spool',
  async (importOriginal) => {
    const actual = await importOriginal<typeof Spool>()
    return {
      ...actual,
      drainAgentHookSpoolAsync: (options: Spool.SpoolDrainOptions) => replay.consume(options)
    }
  }
)

vi.mock('./agent-hook-spool-ingest', async (importOriginal) => {
  const actual = await importOriginal<typeof spoolIngest>()
  return { ...actual, drainRelayHookSpool: vi.fn(actual.drainRelayHookSpool) }
})

afterEach(() => {
  vi.restoreAllMocks()
  vi.clearAllMocks()
  vi.useRealTimers()
})

const LEAF = '11111111-1111-4111-8111-111111111111'
const NOW = 10_000_000

it.each([100, 1000])(
  'retains no deferred tool bodies across %s spool files and only arms an eligible accepted owner',
  async (count) => {
    vi.useFakeTimers({ now: NOW, toFake: ['Date', 'performance', 'setTimeout', 'clearTimeout'] })
    const dir = mkdtempSync(join(tmpdir(), 'relay-model-replay-'))
    const transcriptPath = join(dir, 'transcript.jsonl')
    writeFileSync(transcriptPath, '{"source":"USER_EXPLICIT","type":"USER_INPUT"}\n')
    const forward = vi.fn()
    const pane = (name: string) => makePaneKey(name, LEAF)
    const relay = new RelayAgentHookServer({
      endpointDir: dir,
      forward,
      isPaneSurfaceRetired: (key) => key === pane('rejected')
    })
    const schedule = vi.spyOn(AgentTranscriptPollScheduler.prototype, 'schedule')
    const contents = 'x'.repeat(128 * 1024)
    const item = (tabId: string, hookEventName: string, payload: Record<string, unknown>) => ({
      source: 'antigravity',
      paneKey: pane(tabId),
      tabId,
      worktreeId: 'workspace',
      env: 'remote',
      version: 'fixture',
      receivedAt: NOW,
      payload: {
        conversationId: tabId,
        transcriptPath,
        artifactDirectoryPath: dir,
        lastUserInput: 'Task',
        initialNumSteps: 5,
        modelName: 'auto',
        hookEventName,
        ...payload
      }
    })
    replay.consume = async ({ ingest }) => {
      // The real drain hands over each file in turn; only one argument rope is built per record.
      for (let index = 0; index < count; index++) {
        await ingest(
          item(`file-${index}`, 'PostToolUse', {
            modelName: 'explicit',
            toolCall: { name: 'write_file', args: { path: 'file.txt', contents: contents + index } }
          })
        )
      }
      await ingest(item('completed', 'PreInvocation', {}))
      await ingest(item('completed', 'Stop', { fullyIdle: true }))
      await ingest(item('rejected', 'PreInvocation', {}))
      await ingest({ ...item('expired', 'PreInvocation', {}), receivedAt: NOW - 1_800_001 })
      await ingest(item('eligible', 'PreInvocation', {}))
      return count + 5
    }
    try {
      await relay.start()
      const firstDrain = vi.mocked(spoolIngest.drainRelayHookSpool).mock.results[0]
      await expect(firstDrain?.value).resolves.toBeUndefined()
      expect(schedule.mock.calls).toEqual([
        expect.arrayContaining([
          pane('eligible'),
          expect.objectContaining({ body: undefined, env: 'remote', version: 'fixture' })
        ])
      ])
      expect(forward).toHaveBeenCalledWith(
        expect.objectContaining({
          paneKey: pane('completed'),
          payload: expect.objectContaining({ state: 'done' })
        })
      )
    } finally {
      relay.stop()
      rmSync(dir, { recursive: true, force: true })
    }
  }
)
