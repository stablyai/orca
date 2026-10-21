import { expect, it } from 'vitest'
import { quickOpenRecentCandidateSet } from './quick-open-recent-candidates'
it('keeps bounded root-relative candidates without accepting outside paths or traversal', () => {
  expect([
    ...quickOpenRecentCandidateSet([
      'src/file.ts',
      'src/file.ts',
      '../file',
      '/external',
      'C:/external',
      '\\\\host\\share\\file',
      'nested/../file',
      'bad\0file'
    ])
  ]).toEqual(['src/file.ts'])
  expect(() => quickOpenRecentCandidateSet(Array(101).fill('file'))).toThrow('Too many')
  expect(() => quickOpenRecentCandidateSet(['x'.repeat(64 * 1024 + 1)])).toThrow('too large')
})
