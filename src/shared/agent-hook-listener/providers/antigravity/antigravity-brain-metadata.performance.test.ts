import * as fs from 'node:fs'
import fsp from 'node:fs/promises'
import { RolloutReadBatch } from '../codex/codex-rollout-async-reads'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { expect, it, vi } from 'vitest'
import {
  createAntigravityBrainCache,
  readAntigravityBrainSubagents
} from './antigravity-brain-metadata'
import { readAntigravityChildTranscriptTail } from './antigravity-child-transcript'

it.each([10, 100])(
  'does not reread unchanged child transcripts across polls with %s children',
  async (children) => {
    const root = fs.mkdtempSync(join(tmpdir(), 'agy-tail-cache-'))
    const brain = join(root, 'parent')
    const cache = createAntigravityBrainCache()
    const batch = new RolloutReadBatch()
    try {
      for (let i = 0; i < children; i++) {
        const logs = join(root, `child-${i}`, '.system_generated', 'logs')
        fs.mkdirSync(logs, { recursive: true })
        fs.writeFileSync(
          join(logs, 'transcript.jsonl'),
          '{"type":"PLANNER_RESPONSE","model":"model-a","status":"DONE"}\n'
        )
        expect(
          (await readAntigravityChildTranscriptTail(brain, `child-${i}`, cache, batch))?.settled
        ).toBe(true)
      }
      const read = vi.spyOn(fsp, 'open')
      try {
        for (let poll = 0; poll < 10; poll++) {
          for (let i = 0; i < children; i++) {
            expect(
              (await readAntigravityChildTranscriptTail(brain, `child-${i}`, cache, batch))?.model
            ).toBe('model-a')
          }
        }
        expect(read).not.toHaveBeenCalled()
        fs.appendFileSync(
          join(root, 'child-0', '.system_generated', 'logs', 'transcript.jsonl'),
          '{"type":"PLANNER_RESPONSE","model":"model-b","tool_calls":[{"name":"read_file","args":{"path":"src/app.ts"}}]}\n'
        )
        expect(
          await readAntigravityChildTranscriptTail(brain, 'child-0', cache, batch)
        ).toMatchObject({
          model: 'model-b',
          settled: false,
          toolName: 'read_file',
          toolInput: 'src/app.ts'
        })
        expect(read).toHaveBeenCalledTimes(1)
      } finally {
        read.mockRestore()
        batch.release()
      }
    } finally {
      fs.rmSync(root, { recursive: true, force: true })
    }
  }
)

it.each([30, 300])(
  'does not reread retired descriptors or relist an unchanged directory with %s past children',
  async (children) => {
    const root = fs.mkdtempSync(join(tmpdir(), 'agy-descriptor-cache-'))
    const directory = join(root, '.system_generated', 'subagents')
    fs.mkdirSync(directory, { recursive: true })
    const cache = createAntigravityBrainCache()
    const retired = new Set<string>()
    const batch = new RolloutReadBatch()
    try {
      for (let i = 0; i < children; i++) {
        fs.writeFileSync(
          join(directory, `${i}.json`),
          JSON.stringify({ conversationId: `child-${i}`, state: 'SUBAGENT_STATE_KILLED' })
        )
      }
      await readAntigravityBrainSubagents(root, cache, batch, retired)
      const open = vi.spyOn(fsp, 'open')
      const list = vi.spyOn(fsp, 'readdir')
      const stats = vi.spyOn(fsp, 'stat')
      try {
        for (let poll = 0; poll < 10; poll++) {
          expect(await readAntigravityBrainSubagents(root, cache, batch, retired)).toEqual([])
        }
        expect(open).not.toHaveBeenCalled()
        expect(list).not.toHaveBeenCalled()
        expect(stats).toHaveBeenCalledTimes(10)
      } finally {
        open.mockRestore()
        list.mockRestore()
        stats.mockRestore()
      }
    } finally {
      batch.release()
      fs.rmSync(root, { recursive: true, force: true })
    }
  }
)
