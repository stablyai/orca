import { describe, expect, it } from 'vitest'
import { getExplorerDirectoryDepth } from './file-explorer-dir-depth'

describe('getExplorerDirectoryDepth', () => {
  it('computes expanded-directory depth from the workspace or an outside display root', () => {
    expect(getExplorerDirectoryDepth('/repo', '/repo/packages/app', '/repo/packages/app/src')).toBe(
      2
    )
    expect(getExplorerDirectoryDepth('/repo', '/tmp/reference', '/tmp/reference/src')).toBe(0)
    expect(getExplorerDirectoryDepth('/repo', '/tmp/reference', '/tmp/reference/src/lib')).toBe(1)
  })

  it('computes every depth from an ancestor display root while browsing above the workspace', () => {
    expect(getExplorerDirectoryDepth('/home/dev/repo', '/home/dev', '/home/dev/repo')).toBe(0)
    expect(getExplorerDirectoryDepth('/home/dev/repo', '/home/dev', '/home/dev/repo/src')).toBe(1)
  })
})
