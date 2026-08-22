import { describe, expect, it } from 'vitest'
import { gitExecMutatesRepository } from './git-exec-mutation'

describe('gitExecMutatesRepository', () => {
  it.each([
    [['remote', 'add', 'pr-contributor-orca', 'https://github.com/contributor/orca.git']],
    [['remote', 'remove', 'pr-contributor-orca']],
    [['clone', '--', 'https://github.com/stablyai/orca.git', 'orca']],
    [['commit', '--allow-empty', '-m', 'Initial commit']],
    [['init']]
  ])('treats %j as mutating', (args) => {
    expect(gitExecMutatesRepository(args)).toBe(true)
  })

  it.each([
    // Why: these run on read-heavy paths; misclassifying them would flush the
    // git read cache on every remote probe.
    [['remote']],
    [['remote', '-v']],
    [['remote', 'get-url', 'origin']],
    [['remote', 'show', 'origin']],
    [['rev-parse', '--show-toplevel']],
    [[]]
  ])('treats %j as read-only', (args) => {
    expect(gitExecMutatesRepository(args)).toBe(false)
  })
})
