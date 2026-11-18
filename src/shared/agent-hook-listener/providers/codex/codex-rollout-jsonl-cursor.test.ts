import { afterEach, describe, expect, it } from 'vitest'
import { appendFileSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { runProcess } from '@orca/process-host'
import {
  readJsonlCursorBytes,
  readJsonlFirstRecordAsync,
  RolloutReadBatch
} from './codex-rollout-async-reads'
import { applyJsonlCursorBytes, type JsonlCursor } from './codex-rollout-jsonl-format'

const directories: string[] = []

afterEach(() => {
  for (const directory of directories.splice(0)) {
    rmSync(directory, { recursive: true, force: true })
  }
})

describe('async rollout reads', () => {
  it.skipIf(process.platform === 'win32')(
    'reject writer-less FIFOs and symlinks to them instead of pinning a threadpool worker',
    async () => {
      const directory = mkdtempSync(join(tmpdir(), 'codex-rollout-fifo-'))
      directories.push(directory)
      const fifo = join(directory, 'pipe.jsonl')
      const link = join(directory, 'link.jsonl')
      const created = await runProcess({ program: 'mkfifo', args: [fifo], timeoutMs: 5000 })
      expect(created.code).toBe(0)
      symlinkSync(fifo, link)
      const batch = new RolloutReadBatch()
      for (const path of [fifo, link, directory]) {
        await expect(readJsonlFirstRecordAsync(path, batch)).resolves.toBeUndefined()
        await expect(
          readJsonlCursorBytes({ filePath: path, offset: 0, carry: '' }, batch)
        ).resolves.toBeUndefined()
      }
      batch.release()
    }
  )
})

describe('readJsonlCursorBytes', () => {
  const rollout = (contents: string): { path: string; cursor: JsonlCursor } => {
    const directory = mkdtempSync(join(tmpdir(), 'codex-rollout-cursor-'))
    directories.push(directory)
    const path = join(directory, 'rollout.jsonl')
    writeFileSync(path, contents)
    return { path, cursor: { filePath: path, offset: 0, carry: '' } }
  }

  it('applies only the unread part of bytes another reader overtook', async () => {
    const { path, cursor } = rollout('{"a":1}\n')
    const batch = new RolloutReadBatch()
    const early = await readJsonlCursorBytes(cursor, batch)
    appendFileSync(path, '{"a":2}\n')
    const late = await readJsonlCursorBytes(cursor, batch)
    batch.release()
    if (early === 'deferred' || late === 'deferred') {
      throw new Error('a lone batch always fits the read budget')
    }
    expect(applyJsonlCursorBytes(cursor, early)).toEqual([{ a: 1 }])
    expect(applyJsonlCursorBytes(cursor, late)).toEqual([{ a: 2 }])
    // Bytes the cursor has fully consumed yield nothing, never a replay.
    expect(applyJsonlCursorBytes(cursor, early)).toEqual([])
  })
})
