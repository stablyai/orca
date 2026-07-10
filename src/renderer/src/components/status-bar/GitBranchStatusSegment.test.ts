import { describe, expect, it } from 'vitest'
import { isRemoteActionEnabled, syncDotColor } from './GitBranchStatusSegment'
import type { GitUpstreamStatus } from '../../../../shared/git-status-types'

function upstream(overrides: Partial<GitUpstreamStatus>): GitUpstreamStatus {
  return { hasUpstream: true, ahead: 0, behind: 0, ...overrides }
}

describe('syncDotColor', () => {
  it('is muted when there is no upstream', () => {
    expect(syncDotColor(undefined)).toBe('bg-muted-foreground/40')
    expect(syncDotColor(upstream({ hasUpstream: false }))).toBe('bg-muted-foreground/40')
  })

  it('is emerald when up to date with the remote', () => {
    expect(syncDotColor(upstream({ ahead: 0, behind: 0 }))).toBe('bg-emerald-500')
  })

  it('is amber when ahead or behind the remote', () => {
    expect(syncDotColor(upstream({ ahead: 2, behind: 0 }))).toBe('bg-amber-500')
    expect(syncDotColor(upstream({ ahead: 0, behind: 3 }))).toBe('bg-amber-500')
    expect(syncDotColor(upstream({ ahead: 1, behind: 1 }))).toBe('bg-amber-500')
  })
})

describe('isRemoteActionEnabled', () => {
  it('disables remote actions without a resolved upstream', () => {
    expect(isRemoteActionEnabled(undefined)).toBe(false)
    expect(isRemoteActionEnabled(upstream({ hasUpstream: false }))).toBe(false)
  })

  it('enables remote actions once an upstream exists', () => {
    expect(isRemoteActionEnabled(upstream({ hasUpstream: true }))).toBe(true)
  })
})
