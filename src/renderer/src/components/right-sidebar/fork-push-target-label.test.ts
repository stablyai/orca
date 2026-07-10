import { describe, expect, it } from 'vitest'
import type { GitPushTarget } from '../../../../shared/types'
import { describeForkPushTarget } from './fork-push-target-label'

function target(overrides: Partial<GitPushTarget>): GitPushTarget {
  return {
    remoteName: 'pr-contributor-orca',
    branchName: 'contributor/fix',
    ...overrides
  }
}

describe('describeForkPushTarget', () => {
  it('derives owner:branch from an SSH fork URL', () => {
    expect(
      describeForkPushTarget(target({ remoteUrl: 'git@github.com:contributor/orca.git' }))
    ).toBe('contributor:contributor/fix')
  })

  it('derives owner:branch from an HTTPS fork URL', () => {
    expect(
      describeForkPushTarget(target({ remoteUrl: 'https://github.com/contributor/orca.git' }))
    ).toBe('contributor:contributor/fix')
  })

  it('handles a URL without a .git suffix', () => {
    expect(
      describeForkPushTarget(target({ remoteUrl: 'https://github.com/contributor/orca' }))
    ).toBe('contributor:contributor/fix')
  })

  it('falls back to remoteName/branch when there is no remote URL', () => {
    expect(describeForkPushTarget(target({ remoteUrl: undefined }))).toBe(
      'pr-contributor-orca/contributor/fix'
    )
  })

  it('works for non-GitHub hosts via the generic owner segment', () => {
    expect(
      describeForkPushTarget(target({ remoteUrl: 'git@gitlab.com:contributor/orca.git' }))
    ).toBe('contributor:contributor/fix')
  })
})
