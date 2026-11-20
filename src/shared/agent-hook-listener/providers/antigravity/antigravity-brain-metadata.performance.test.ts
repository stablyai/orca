import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { expect, it, vi } from 'vitest'
import * as fsp from 'node:fs/promises'
import { readAntigravityChildMetadata } from './antigravity-brain-metadata'
import { retireAntigravityChild } from './antigravity-pane-state'
import { createHookListenerState } from '../../listener-state'
import {
  getOrCreateAntigravityPaneState,
  recordAntigravityChildHook
} from './antigravity-pane-state'
import {
  readAntigravityTranscriptPoll,
  pollAntigravityTranscriptStatus
} from './antigravity-transcript-poll'
vi.mock('node:fs/promises', async (original) => {
  const actual = await original<typeof fsp>()
  return {
    ...actual,
    open: vi.fn(actual.open),
    readdir: vi.fn(actual.readdir),
    stat: vi.fn(actual.stat)
  }
})

it.each([100, 1000])(
  'does no history discovery with %s interrupted children on disk',
  async (history) => {
    const dir = mkdtempSync(join(tmpdir(), 'agy-history-'))
    const state = createHookListenerState()
    const pane = getOrCreateAntigravityPaneState(state, 'pane')
    pane.rootBrainDir = join(dir, 'root')
    pane.rootConversationId = 'root'
    pane.leadModel = 'model-a'
    const descriptors = join(pane.rootBrainDir, '.system_generated', 'subagents')
    mkdirSync(descriptors, { recursive: true })
    try {
      for (let i = 0; i < history; i++) {
        writeFileSync(
          join(descriptors, `old-${i}.json`),
          JSON.stringify({ conversationId: `old-${i}`, state: 'SUBAGENT_STATE_ALIVE' })
        )
      }
      writeFileSync(
        join(descriptors, 'live.json'),
        '{"conversationId":"live","state":"SUBAGENT_STATE_ALIVE","subagentDescriptor":{"role":"Research"}}'
      )
      recordAntigravityChildHook(pane, 'live', 'PreInvocation', { modelName: 'model-b' }, 1)
      vi.mocked(fsp.open).mockClear()
      vi.mocked(fsp.stat).mockClear()
      vi.mocked(fsp.readdir).mockClear()
      const row = {
        paneKey: 'pane',
        connectionId: null,
        payload: { state: 'working' as const, agentType: 'antigravity' as const, prompt: 'Task' }
      }
      expect(
        pollAntigravityTranscriptStatus(
          state,
          row,
          await readAntigravityTranscriptPoll(state, 'pane')
        )?.payload.subagents?.map((child) => child.id)
      ).toEqual(['live'])
      expect(fsp.readdir).toHaveBeenCalledTimes(0)
      expect(fsp.open).toHaveBeenCalledTimes(1)
      vi.mocked(fsp.open).mockClear()
      vi.mocked(fsp.stat).mockClear()
      for (let i = 0; i < 10; i++) {
        await readAntigravityTranscriptPoll(state, 'pane')
      }
      expect(fsp.open).toHaveBeenCalledTimes(0)
      expect(fsp.stat).toHaveBeenCalledTimes(20)
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  }
)

it.each([10, 100])(
  'does not restore metadata cached after %s child retirements',
  async (children) => {
    const dir = mkdtempSync(join(tmpdir(), 'agy-retired-cache-'))
    const state = createHookListenerState()
    const pane = getOrCreateAntigravityPaneState(state, 'pane')
    pane.rootBrainDir = dir
    const descriptors = join(dir, '.system_generated', 'subagents')
    mkdirSync(descriptors, { recursive: true })
    try {
      for (let i = 0; i < children; i++) {
        const id = `child-${i}`
        writeFileSync(join(descriptors, `${id}.json`), JSON.stringify({ conversationId: id }))
        recordAntigravityChildHook(pane, id, 'PreInvocation', {}, i)
        const child = pane.children.get(id)
        const read = readAntigravityChildMetadata(
          dir,
          id,
          pane.brainCache,
          () => pane.children.get(id) === child
        )
        retireAntigravityChild(pane, id)
        expect(await read).toBeUndefined()
      }
      expect(pane.brainCache.jsonFiles.size).toBe(0)
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  }
)
