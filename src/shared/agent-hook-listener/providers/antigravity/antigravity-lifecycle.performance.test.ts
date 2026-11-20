import { appendFileSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { expect, it } from 'vitest'
import { createHookListenerState } from '../../listener-state'
import { RolloutReadBatch } from '../codex/codex-rollout-async-reads'
import { normalizeAntigravityEvent } from './antigravity-events'
import { getOrCreateAntigravityPaneState, retireAntigravityChild } from './antigravity-pane-state'
import { readAntigravityChildTranscriptTail } from './antigravity-child-transcript'
import {
  pollAntigravityTranscriptStatus,
  readAntigravityTranscriptPoll
} from './antigravity-transcript-poll'

it.each([10, 100])(
  'does not produce status frames for unchanged child hooks with %s live children',
  (children) => {
    const state = createHookListenerState()
    const root = { conversationId: 'root', artifactDirectoryPath: '/brain/root' }
    normalizeAntigravityEvent(state, 'PreInvocation', 'Task', 'pane', root, 'root')
    normalizeAntigravityEvent(
      state,
      'PreToolUse',
      '',
      'pane',
      { ...root, toolCall: { name: 'invoke_subagent' } },
      'root'
    )
    for (let i = 0; i < children; i++) {
      expect(
        normalizeAntigravityEvent(
          state,
          'PreInvocation',
          '',
          'pane',
          { conversationId: `child-${i}` },
          'child'
        )
      ).not.toBeNull()
    }
    let frames = 0
    for (let pass = 0; pass < 10; pass++) {
      for (let i = 0; i < children; i++) {
        if (
          normalizeAntigravityEvent(
            state,
            'PostInvocation',
            '',
            'pane',
            { conversationId: `child-${i}` },
            'child'
          )
        ) {
          frames++
        }
      }
    }
    expect(frames).toBe(0)
    expect(
      normalizeAntigravityEvent(
        state,
        'PreToolUse',
        '',
        'pane',
        {
          conversationId: 'child-0',
          toolCall: { name: 'read_file', args: { path: 'src/app.ts' } }
        },
        'child'
      )?.subagents?.[0]
    ).toMatchObject({ toolName: 'read_file', toolInput: 'src/app.ts' })
  }
)

it.each([30, 300])(
  'releases finished transcript projections before polling after %s children',
  async (children) => {
    const dir = mkdtempSync(join(tmpdir(), 'agy-retire-'))
    const state = createHookListenerState()
    const pane = getOrCreateAntigravityPaneState(state, 'pane')
    pane.rootBrainDir = join(dir, 'root')
    pane.rootConversationId = 'root'
    pane.leadModel = 'model-a'
    pane.leadState = 'working'
    try {
      for (let i = 0; i < children; i++) {
        const id = `child-${i}`
        const logs = join(dir, id, '.system_generated', 'logs')
        mkdirSync(logs, { recursive: true })
        writeFileSync(
          join(logs, 'transcript.jsonl'),
          '{"type":"PLANNER_RESPONSE","status":"DONE"}\n'
        )
        const batch = new RolloutReadBatch()
        try {
          const tail = await readAntigravityChildTranscriptTail(
            pane.rootBrainDir,
            id,
            pane.brainCache,
            batch
          )
          if (tail) {
            pane.transcriptTails.set(id, tail)
          }
        } finally {
          batch.release()
        }
        retireAntigravityChild(pane, id)
      }
      const reads = await readAntigravityTranscriptPoll(state, 'pane')
      const row = {
        paneKey: 'pane',
        connectionId: null,
        payload: { agentType: 'antigravity' as const, state: 'working' as const, prompt: 'Task' }
      }
      pollAntigravityTranscriptStatus(state, row, reads)
      expect(pane.transcriptTails.size).toBe(0)
      expect(pane.brainCache.transcripts.size).toBe(0)
      expect(reads?.tails.size).toBe(0)
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  }
)

it('bounds an unfinished transcript record across appends and recovers after its newline', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'agy-line-limit-'))
  const state = createHookListenerState()
  const pane = getOrCreateAntigravityPaneState(state, 'pane')
  const brain = join(dir, 'root')
  const logs = join(dir, 'child', '.system_generated', 'logs')
  mkdirSync(logs, { recursive: true })
  const transcript = join(logs, 'transcript.jsonl')
  writeFileSync(transcript, '')
  try {
    for (let i = 0; i < 20; i++) {
      appendFileSync(transcript, 'x'.repeat(256 * 1024))
      const batch = new RolloutReadBatch()
      try {
        await readAntigravityChildTranscriptTail(brain, 'child', pane.brainCache, batch)
      } finally {
        batch.release()
      }
      expect(
        pane.brainCache.transcripts.get(transcript)?.cursor.carry.length ?? 0
      ).toBeLessThanOrEqual(262144)
    }
    appendFileSync(transcript, '\n{"type":"PLANNER_RESPONSE","status":"DONE","model":"model-a"}\n')
    const batch = new RolloutReadBatch()
    try {
      expect(
        await readAntigravityChildTranscriptTail(brain, 'child', pane.brainCache, batch)
      ).toMatchObject({ settled: true, model: 'model-a' })
    } finally {
      batch.release()
    }
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})
