import { describe, expect, it } from 'vitest'
import { classifyWorktreeScanFailure } from './worktree-scan-failure'

describe('classifyWorktreeScanFailure', () => {
  it('recognizes Xcode license failures', () => {
    expect(
      classifyWorktreeScanFailure('Agreeing to the Xcode/iOS license requires admin privileges')
    ).toBe('xcode-license')
  })
  it('recognizes missing developer tools', () => {
    expect(classifyWorktreeScanFailure('xcode-select: error: no developer tools were found')).toBe(
      'developer-tools'
    )
  })
  it('does not prescribe installation for an unspecified xcode-select path error', () => {
    expect(classifyWorktreeScanFailure('xcode-select: error: invalid active developer path')).toBe(
      'unknown'
    )
  })
  it('recognizes architecture spawn failures', () => {
    expect(classifyWorktreeScanFailure('spawn Unknown system error -86')).toBe(
      'architecture-mismatch'
    )
  })
  it('keeps unrecognized failures unknown', () => {
    expect(classifyWorktreeScanFailure('git failed for an unspecified reason')).toBe('unknown')
  })
})
