import { afterEach, describe, expect, it } from 'vitest'
import { appendFileSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { runProcess } from '@orca/process-host'
import { readJsonlCursorBytes, RolloutReadBatch } from './codex-rollout-async-reads'
import { applyJsonlCursorBytes, type JsonlCursor } from './codex-rollout-jsonl-format'

const directories: string[] = []

afterEach(() => {
  for (const directory of directories.splice(0)) {
    rmSync(directory, { recursive: true, force: true })
  }
})

describe('readJsonlFirstRecord', () => {
  it.skipIf(process.platform === 'win32')(
    'rejects writer-less FIFOs and symlinks to them without blocking',
    async () => {
      const directory = mkdtempSync(join(tmpdir(), 'codex-rollout-fifo-'))
      directories.push(directory)
      const fifo = join(directory, 'pipe.jsonl')
      const link = join(directory, 'link.jsonl')
      const created = await runProcess({ program: 'mkfifo', args: [fifo], timeoutMs: 5000 })
      expect(created.code).toBe(0)
      symlinkSync(fifo, link)
      const readerPath = resolve(
        'src/shared/agent-hook-listener/providers/codex/codex-rollout-jsonl-cursor.ts'
      )
      const result = await runProcess({
        program: process.execPath,
        args: [
          '--import',
          'tsx',
          '--eval',
          `const assert = require('node:assert/strict');
const { readJsonlFirstRecord } = require(${JSON.stringify(readerPath)});
for (const path of ${JSON.stringify([fifo, link, directory])}) {
  assert.equal(readJsonlFirstRecord(path), undefined);
}`
        ],
        timeoutMs: 5000
      })
      expect(result.timedOut).toBe(false)
      expect(result.code, result.stderr).toBe(0)
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
