import { describe, expect, it } from 'vitest'
import { resolve } from 'node:path'
import { scanSourceTree, stripComments } from './source-scan/source-tree-scan'

const BARE_FENCE_MINT = /runtimeFence\s*:\s*[^\n]*\.runtimeFence\s*\+\s*1\b/

describe('agent-session fence mint boundary', () => {
  it('rejects direct runtimeFence increments in shipped source', () => {
    const offenders = scanSourceTree(resolve(__dirname, '..', '..', 'src'))
      .filter(({ source }) => BARE_FENCE_MINT.test(stripComments(source)))
      .map(({ relativePath }) => relativePath)

    expect(
      offenders,
      'New bare runtimeFence mint. Route the assignment through nextAgentSessionFence(...).'
    ).toEqual([])
  })
})
