import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'

function readSource(relativePath: string): string {
  return readFileSync(join(__dirname, relativePath), 'utf8')
}

function expectEveryCallToCarryExecutionHost(source: string, callName: string): void {
  let cursor = 0
  let callCount = 0
  while (true) {
    const callStart = source.indexOf(`${callName}(`, cursor)
    if (callStart < 0) {
      break
    }
    callCount += 1
    const optionWindow = source.slice(callStart, callStart + 500)
    expect(optionWindow, `${callName} call #${callCount}`).toContain('executionHostId')
    cursor = callStart + callName.length + 1
  }
  expect(callCount).toBeGreaterThan(0)
}

describe('hosted-review caller host boundaries', () => {
  it('propagates concrete owners from worktree cards', () => {
    const source = readSource('../sidebar/WorktreeCard.tsx')
    expectEveryCallToCarryExecutionHost(source, 'fetchHostedReviewForBranch')
  })

  it('resolves the checks-panel repo through the active worktree owner and propagates it', () => {
    const source = readSource('ChecksPanel.tsx')
    expect(source).toContain('findRepoForWorktreeOwner(s.repos, activeWorktree)')
    expectEveryCallToCarryExecutionHost(source, 'fetchHostedReviewForBranch')
    expectEveryCallToCarryExecutionHost(source, 'refreshHostedReviewCard')
    expectEveryCallToCarryExecutionHost(source, 'getHostedReviewCreationEligibility')
    expectEveryCallToCarryExecutionHost(source, 'createHostedReview')
  })

  it('resolves the source-control repo through the active worktree owner and propagates it', () => {
    const source = readSource('SourceControl.tsx')
    expect(source).toContain('findRepoForWorktreeOwner(s.repos, activeWorktree)')
    expectEveryCallToCarryExecutionHost(source, 'fetchHostedReviewForBranch')
    expectEveryCallToCarryExecutionHost(source, 'getHostedReviewCreationEligibility')
    expectEveryCallToCarryExecutionHost(source, 'createHostedReview')
  })

  it('scopes PR-check repository selection to the requested execution host', () => {
    const source = readSource('../../store/slices/github.ts')
    expect(source).toContain('hostId: options.executionHostId')
    expect(source).toContain('if (options?.executionHostId && !repo)')
  })
})
