import { describe, expect, it } from 'vitest'
import {
  limitQuickOpenFilesBySerializedBytes,
  limitQuickOpenSearchReplyBySerializedBytes,
  serializedQuickOpenPathBytes
} from './quick-open-transport-budget'

describe('Quick Open transport byte budget', () => {
  it('matches JSON.stringify byte accounting, including escaped paths', () => {
    const path = 'src/line\nquote".ts'
    expect(serializedQuickOpenPathBytes(path)).toBe(Buffer.byteLength(JSON.stringify(path), 'utf8'))
  })

  it('returns the largest prefix that fits as a JSON array', () => {
    const files = ['src/a.ts', 'data/ignored\nfile.bin', 'src/b.ts']
    const budget = Buffer.byteLength(JSON.stringify(files.slice(0, 2)), 'utf8')
    expect(limitQuickOpenFilesBySerializedBytes(files, budget)).toEqual(files.slice(0, 2))
  })

  it('drops the lowest-ranked reply entries until the complete result fits', () => {
    const result = {
      worktree: 'wt-1',
      rootPath: '/repo',
      files: [
        { relativePath: 'src/b.ts', basename: 'b.ts', kind: 'text' as const },
        { relativePath: 'src/a.ts', basename: 'a.ts', kind: 'text' as const }
      ],
      totalCount: 2,
      truncated: false
    }
    const budget = Buffer.byteLength(
      JSON.stringify({ ...result, files: result.files.slice(0, 1) }),
      'utf8'
    )
    expect(limitQuickOpenSearchReplyBySerializedBytes(result, budget).files).toHaveLength(1)
    expect(limitQuickOpenSearchReplyBySerializedBytes(result, budget).truncated).toBe(true)
  })
})
