import { describe, expect, it } from 'vitest'
import { partitionTrackedPathSpecs } from './git-tracked-pathspecs'

describe('tracked pathspec partition', () => {
  it('preserves original spelling, duplicates and relative order in both action lists', () => {
    const requests = ['new', 'docs\\', '[ab].txt', 'docs///', 'new', 'src/file', 'docs\\']
    const tracked = ['docs/readme', 'src/file-extra', '[ab].txt', 'docs/readme']
    expect(partitionTrackedPathSpecs(requests, tracked)).toEqual({
      trackedPaths: ['docs\\', '[ab].txt', 'docs///', 'docs\\'],
      untrackedPaths: ['new', 'new', 'src/file']
    })
  })
})
