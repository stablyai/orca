import { describe, expect, it } from 'vitest'
import {
  getLandingPreflightIssues,
  hasGitHubBackedProject,
  type LandingPreflightStatus
} from './landing-preflight-issues'
import type { Repo } from '../../../shared/types'

function repo(overrides: Partial<Repo> & Pick<Repo, 'id' | 'path' | 'displayName'>): Repo {
  return {
    badgeColor: '#737373',
    addedAt: 100,
    kind: 'git',
    ...overrides
  }
}

const missingGhStatus: LandingPreflightStatus = {
  git: { installed: true },
  gh: { installed: false, authenticated: false }
}

describe('landing preflight issues', () => {
  it('keeps Git issues even when no GitHub-backed project is registered', () => {
    const issues = getLandingPreflightIssues(
      {
        git: { installed: false },
        gh: { installed: false, authenticated: false }
      },
      { hasGitHubBackedProject: false }
    )

    expect(issues.map((issue) => issue.id)).toEqual(['git'])
  })

  it('does not report GitHub CLI issues when no GitHub-backed project is registered', () => {
    const issues = getLandingPreflightIssues(missingGhStatus, {
      hasGitHubBackedProject: false
    })

    expect(issues.some((issue) => issue.id.startsWith('gh'))).toBe(false)
  })

  it('keeps GitHub CLI issues when a GitHub-backed project is registered', () => {
    const issues = getLandingPreflightIssues(missingGhStatus, {
      hasGitHubBackedProject: true
    })

    expect(issues.map((issue) => issue.id)).toContain('gh')
  })

  it('reports GitHub auth issue when gh is installed but unauthenticated', () => {
    const issues = getLandingPreflightIssues(
      {
        git: { installed: true },
        gh: { installed: true, authenticated: false }
      },
      { hasGitHubBackedProject: true }
    )

    expect(issues.map((issue) => issue.id)).toContain('gh-auth')
  })

  it('treats GitLab-only registered projects as not GitHub-backed', () => {
    expect(
      hasGitHubBackedProject([
        repo({
          id: 'gitlab-repo',
          path: '/Users/alice/gitlab',
          displayName: 'gitlab'
        })
      ])
    ).toBe(false)
  })

  it('detects GitHub-backed projects from generated avatar metadata', () => {
    expect(
      hasGitHubBackedProject([
        repo({
          id: 'github-repo',
          path: '/Users/alice/orca',
          displayName: 'orca',
          repoIcon: {
            type: 'image',
            src: 'https://github.com/stablyai.png?size=64',
            source: 'github',
            label: 'stablyai/orca'
          }
        })
      ])
    ).toBe(true)
  })

  it('detects GitHub-backed projects from existing provider metadata', () => {
    expect(
      hasGitHubBackedProject([
        repo({
          id: 'github-repo',
          path: '/Users/alice/orca',
          displayName: 'orca',
          upstream: { owner: 'stablyai', repo: 'orca' }
        })
      ])
    ).toBe(true)
  })
})
