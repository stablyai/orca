import { appendFileSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { expect, it, vi } from 'vitest'
import type { AgentHookEventPayload } from '../../listener-event'
import { createHookListenerState } from '../../listener-state'
import { RolloutReadBatch } from '../codex/codex-rollout-async-reads'
import { normalizeAntigravityEvent } from './antigravity-events'
import {
  getOrCreateAntigravityPaneState,
  recordAntigravityChildHook,
  verifyAntigravityChild
} from './antigravity-pane-state'
import { readAntigravityChildTranscriptTail } from './antigravity-child-transcript'
import {
  hasAntigravityPollWork,
  pollAntigravityTranscriptStatus,
  readAntigravityTranscriptPoll
} from './antigravity-transcript-poll'
import { transcriptPollUpdate } from '../../transcript-poll-policy'

it.each([10, 100])(
  'coalesces %s live child tool bursts and releases rotating workers',
  async (children) => {
    const state = createHookListenerState()
    const dir = mkdtempSync(join(tmpdir(), 'agy-child-burst-'))
    const swarm = join(dir, 'root', '.system_generated', 'swarm')
    mkdirSync(swarm, { recursive: true })
    writeFileSync(
      join(swarm, 'members.json'),
      JSON.stringify({
        members: Object.fromEntries(
          Array.from({ length: children }, (_, i) => [
            `worker-${i}`,
            { conversation_id: `child-${i}`, applied_model: 'model-b' }
          ])
        )
      })
    )
    const root = {
      conversationId: 'root',
      lastUserInput: 'Task',
      modelName: 'model-a',
      artifactDirectoryPath: join(dir, 'root')
    }
    try {
      normalizeAntigravityEvent(state, 'PreInvocation', 'Task', 'pane', root, 'root')
      normalizeAntigravityEvent(
        state,
        'PreToolUse',
        '',
        'pane',
        { ...root, toolCall: { name: 'send_message' } },
        'root'
      )
      let frames = 0
      for (let pass = 0; pass < 10; pass++) {
        for (let i = 0; i < children; i++) {
          const payload = {
            conversationId: `child-${i}`,
            toolCall: { name: 'read_file', args: { path: `src/app-${pass}.ts` } }
          }
          if (normalizeAntigravityEvent(state, 'PreToolUse', '', 'pane', payload, 'child')) {
            frames++
          }
        }
      }
      expect(frames).toBe(0)
      const row: AgentHookEventPayload = {
        paneKey: 'pane',
        connectionId: null,
        payload: { state: 'working' as const, agentType: 'antigravity' as const, prompt: 'Task' }
      }
      const polled = pollAntigravityTranscriptStatus(
        state,
        row,
        await readAntigravityTranscriptPoll(state, 'pane')
      )!
      expect(transcriptPollUpdate('antigravity', row, polled)?.payload.subagents).toHaveLength(
        children
      )
      expect(
        transcriptPollUpdate(
          'antigravity',
          polled,
          pollAntigravityTranscriptStatus(
            state,
            polled,
            await readAntigravityTranscriptPoll(state, 'pane')
          )!
        )
      ).toBeUndefined()
      const pane = state.antigravityChildWorkByPaneKey.get('pane')!
      for (let i = 0; i < children; i++) {
        recordAntigravityChildHook(pane, `child-${i}`, 'Stop', { fullyIdle: true }, 2)
      }
      expect(pane.children.size).toBe(0)
      expect(pane.verifiedChildren.size).toBe(0)
      expect(pane.brainCache.transcripts.size).toBe(0)
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  }
)

it('bounds an unfinished model transcript record and recovers after truncation to zero', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'agy-line-limit-'))
  const pane = getOrCreateAntigravityPaneState(createHookListenerState(), 'pane')
  const brain = join(dir, 'root')
  const logs = join(dir, 'child', '.system_generated', 'logs')
  mkdirSync(logs, { recursive: true })
  const path = join(logs, 'transcript.jsonl')
  writeFileSync(path, '')
  const read = async (): Promise<unknown> => {
    const batch = new RolloutReadBatch()
    try {
      return await readAntigravityChildTranscriptTail(brain, 'child', pane.brainCache, batch)
    } finally {
      batch.release()
    }
  }
  try {
    for (let i = 0; i < 20; i++) {
      appendFileSync(path, 'x'.repeat(256 * 1024))
      await read()
      expect(pane.brainCache.transcripts.get(path)?.cursor.carry.length ?? 0).toBeLessThanOrEqual(
        262144
      )
    }
    writeFileSync(path, '')
    await read()
    appendFileSync(path, '{"type":"PLANNER_RESPONSE","status":"DONE","model":"model-a"}\n')
    expect(await read()).toMatchObject({ model: 'model-a' })
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

it.each([10, 100])('retires %s verified siblings without traversing the roster', (children) => {
  const pane = getOrCreateAntigravityPaneState(createHookListenerState(), 'pane')
  for (let i = 0; i < children; i++) {
    recordAntigravityChildHook(pane, `child-${i}`, 'PreInvocation', {}, 1)
    verifyAntigravityChild(pane, `child-${i}`)
  }
  const values = vi.spyOn(pane.children, 'values')
  const entries = vi.spyOn(pane.children, Symbol.iterator)
  try {
    for (let i = 0; i < children - 1; i++) {
      recordAntigravityChildHook(pane, `child-${i}`, 'Stop', { fullyIdle: true }, 2)
    }
    expect(pane.helpersIdleAt).toBeUndefined()
    recordAntigravityChildHook(pane, `child-${children - 1}`, 'Stop', { fullyIdle: true }, 2)
    expect(pane.helpersIdleAt).toEqual(expect.any(Number))
    expect(pane.verifiedChildren.size).toBe(0)
    expect(values).toHaveBeenCalledTimes(0)
    expect(entries).toHaveBeenCalledTimes(0)
  } finally {
    values.mockRestore()
    entries.mockRestore()
  }
})

it.each([10, 100])(
  'does not copy %s existing candidate IDs when another helper starts',
  (children) => {
    const state = createHookListenerState()
    const root = { conversationId: 'root', lastUserInput: 'Task' }
    normalizeAntigravityEvent(state, 'PreInvocation', 'Task', 'pane', root, 'root')
    const pane = state.antigravityChildWorkByPaneKey.get('pane')!
    for (let i = 0; i < children; i++) {
      recordAntigravityChildHook(pane, `child-${i}`, 'PreInvocation', {}, 1)
    }
    const keys = vi.spyOn(pane.children, 'keys')
    try {
      normalizeAntigravityEvent(
        state,
        'PreToolUse',
        '',
        'pane',
        { ...root, toolCall: { name: 'invoke_subagent' } },
        'root'
      )
      expect(keys).toHaveBeenCalledTimes(0)
    } finally {
      keys.mockRestore()
    }
  }
)

it.each([100, 1000])(
  'reads no transcript for %s automatic Swarm workers whose membership names the model',
  async (workers) => {
    const dir = mkdtempSync(join(tmpdir(), 'agy-swarm-models-'))
    try {
      const swarm = join(dir, 'root', '.system_generated', 'swarm')
      mkdirSync(swarm, { recursive: true })
      const members: Record<string, unknown> = {}
      for (let i = 0; i < workers; i++) {
        members[`w${i}`] = { conversation_id: `w-${i}`, phase: 'RUNNING', applied_model: 'model-b' }
        const logs = join(dir, `w-${i}`, '.system_generated', 'logs')
        mkdirSync(logs, { recursive: true })
        writeFileSync(
          join(logs, 'transcript.jsonl'),
          '{"type":"PLANNER_RESPONSE","model":"model-c"}\n'
        )
      }
      writeFileSync(join(swarm, 'members.json'), JSON.stringify({ members }))
      const state = createHookListenerState()
      const root = {
        conversationId: 'root',
        lastUserInput: 'Task',
        modelName: 'model-a',
        transcriptPath: join(dir, 'root', '.system_generated', 'logs', 'transcript.jsonl')
      }
      normalizeAntigravityEvent(state, 'PreInvocation', 'Task', 'pane', root, 'root')
      const pane = state.antigravityChildWorkByPaneKey.get('pane')!
      for (let i = 0; i < workers; i++) {
        recordAntigravityChildHook(pane, `w-${i}`, 'PreInvocation', { modelName: 'auto' }, 1)
      }
      const row: AgentHookEventPayload = {
        paneKey: 'pane',
        connectionId: null,
        payload: { state: 'working' as const, agentType: 'antigravity' as const, prompt: 'Task' }
      }
      for (let poll = 0; poll < 3; poll++) {
        const polled = pollAntigravityTranscriptStatus(
          state,
          row,
          await readAntigravityTranscriptPoll(state, 'pane')
        )
        expect(polled?.payload.subagents).toHaveLength(workers)
        expect(polled?.payload.subagents?.every((child) => child.model === 'model-b')).toBe(true)
      }
      expect(pane.brainCache.transcripts.size).toBe(0)
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  }
)

it.each([100, 1000])(
  'admits no root-model polls for %s automatic panes until each root has a conversation id',
  (panes) => {
    const state = createHookListenerState()
    const polling = (): number => {
      let count = 0
      for (let i = 0; i < panes; i++) {
        const event: AgentHookEventPayload = {
          paneKey: `pane-${i}`,
          connectionId: null,
          payload: { state: 'working', agentType: 'antigravity', prompt: '' }
        }
        if (hasAntigravityPollWork(state, event)) {
          count++
        }
      }
      return count
    }
    const hook = (i: number, extra: Record<string, unknown>) => ({
      lastUserInput: 'Task',
      modelName: 'auto',
      transcriptPath: `/brain/root-${i}/.system_generated/logs/transcript.jsonl`,
      ...extra
    })
    for (let i = 0; i < panes; i++) {
      normalizeAntigravityEvent(state, 'PreInvocation', 'Task', `pane-${i}`, hook(i, {}), 'root')
    }
    expect(polling()).toBe(0)
    for (let i = 0; i < panes; i++) {
      const payload = hook(i, { conversationId: `root-${i}` })
      normalizeAntigravityEvent(state, 'PreInvocation', 'Task', `pane-${i}`, payload, 'root')
    }
    expect(polling()).toBe(panes)
    for (let i = 0; i < panes; i++) {
      const payload = hook(i, { conversationId: `root-${i}`, fullyIdle: true })
      normalizeAntigravityEvent(state, 'Stop', '', `pane-${i}`, payload, 'root')
    }
    expect(polling()).toBe(0)
  }
)
