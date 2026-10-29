import { afterEach, describe, expect, it } from 'vitest'
import { mkdtempSync, rmSync, symlinkSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { runProcess } from '@orca/process-host'

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
      const readerPath = resolve('src/shared/codex-rollout-jsonl-cursor.ts')
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
