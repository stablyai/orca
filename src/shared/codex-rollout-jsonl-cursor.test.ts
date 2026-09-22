import { constants, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { readJsonlCursor } from './codex-rollout-jsonl-cursor'

const hasNoFollow = typeof constants.O_NOFOLLOW === 'number' && constants.O_NOFOLLOW !== 0

describe('readJsonlCursor', () => {
  it('returns no records for an empty regular file', () => {
    const dir = mkdtempSync(join(tmpdir(), 'orca-cursor-empty-'))
    try {
      const file = join(dir, 'rollout.jsonl')
      writeFileSync(file, '')
      expect(readJsonlCursor({ filePath: file, offset: 0, carry: '' })).toEqual([])
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  it('reads a new jsonl record and advances the offset', () => {
    const dir = mkdtempSync(join(tmpdir(), 'orca-cursor-read-'))
    try {
      const file = join(dir, 'rollout.jsonl')
      writeFileSync(file, '{"type":"turn"}\n')
      const cursor = { filePath: file, offset: 0, carry: '' }
      expect(readJsonlCursor(cursor)).toEqual([{ type: 'turn' }])
      expect(cursor.offset).toBeGreaterThan(0)
      expect(readJsonlCursor(cursor)).toEqual([])
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  it.skipIf(!hasNoFollow)('does not read a symlink swapped in for the rollout', () => {
    const dir = mkdtempSync(join(tmpdir(), 'orca-cursor-link-'))
    try {
      const secret = join(dir, 'secret.jsonl')
      const link = join(dir, 'rollout.jsonl')
      writeFileSync(secret, '{"type":"leaked"}\n')
      symlinkSync(secret, link)
      expect(readJsonlCursor({ filePath: link, offset: 0, carry: '' })).toBeUndefined()
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })
})
