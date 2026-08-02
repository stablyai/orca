import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { Repo } from '../../../shared/types'
import {
  dismissPreflightIssue,
  githubProjectKeys,
  isPreflightIssueDismissed
} from './landing-preflight-dismissal'

function repo(overrides: Partial<Repo> & Pick<Repo, 'id'>): Repo {
  return {
    path: `/repos/${overrides.id}`,
    displayName: overrides.id,
    badgeColor: '#737373',
    addedAt: 100,
    kind: 'git',
    ...overrides
  }
}

const githubRepo = (id: string, owner: string, name: string): Repo =>
  repo({ id, upstream: { owner, repo: name } })

const gitlabRepo = (id: string): Repo => repo({ id, repoIcon: { type: 'lucide', name: 'gitlab' } })

const folderRepo = (id: string): Repo => repo({ id })

function createMemoryStorage(): Storage {
  const map = new Map<string, string>()
  return {
    get length() {
      return map.size
    },
    clear: () => map.clear(),
    getItem: (key) => map.get(key) ?? null,
    key: (index) => [...map.keys()][index] ?? null,
    removeItem: (key) => map.delete(key),
    setItem: (key, value) => map.set(key, value)
  }
}

beforeEach(() => {
  vi.stubGlobal('localStorage', createMemoryStorage())
})

afterEach(() => {
  vi.unstubAllGlobals()
})

describe('githubProjectKeys', () => {
  it('returns identity keys only for GitHub-backed repos', () => {
    const keys = githubProjectKeys([
      githubRepo('a', 'stablyai', 'orca'),
      gitlabRepo('b'),
      folderRepo('c')
    ])
    expect(keys).toEqual(['github:stablyai/orca'])
  })

  it('de-dupes the same GitHub project added twice and sorts deterministically', () => {
    const keys = githubProjectKeys([
      githubRepo('a2', 'stablyai', 'orca'),
      githubRepo('a1', 'stablyai', 'orca'),
      githubRepo('z', 'octocat', 'hello')
    ])
    expect(keys).toEqual(['github:octocat/hello', 'github:stablyai/orca'])
  })

  it('is empty for a GitLab-only / folder-only workspace', () => {
    expect(githubProjectKeys([gitlabRepo('b'), folderRepo('c')])).toEqual([])
  })
})

describe('isPreflightIssueDismissed', () => {
  it('is not dismissed before any dismiss call', () => {
    expect(isPreflightIssueDismissed('gh', [gitlabRepo('b')])).toBe(false)
  })

  it('stays dismissed for a GitLab-only workspace (the #5670 case)', () => {
    const repos = [gitlabRepo('b'), folderRepo('c')]
    dismissPreflightIssue('gh', repos)
    expect(isPreflightIssueDismissed('gh', repos)).toBe(true)
  })

  it('stays dismissed when an existing GitHub project is unchanged', () => {
    const repos = [githubRepo('a', 'stablyai', 'orca')]
    dismissPreflightIssue('gh', repos)
    expect(isPreflightIssueDismissed('gh', repos)).toBe(true)
  })

  it('re-surfaces when a NEW GitHub project is added', () => {
    const repos = [gitlabRepo('b')]
    dismissPreflightIssue('gh', repos)
    const withNewGithub = [...repos, githubRepo('a', 'stablyai', 'orca')]
    expect(isPreflightIssueDismissed('gh', withNewGithub)).toBe(false)
  })

  it('stays dismissed when only a GitLab/folder repo is added', () => {
    const repos = [githubRepo('a', 'stablyai', 'orca')]
    dismissPreflightIssue('gh', repos)
    const withMoreNonGithub = [...repos, gitlabRepo('b'), folderRepo('c')]
    expect(isPreflightIssueDismissed('gh', withMoreNonGithub)).toBe(true)
  })

  it('stays dismissed when a GitHub project is removed then re-added (set-based)', () => {
    const repos = [githubRepo('a', 'stablyai', 'orca')]
    dismissPreflightIssue('gh', repos)
    // Same identity key re-appears under a different repo id — not a new project.
    const reAdded = [githubRepo('a-again', 'stablyai', 'orca')]
    expect(isPreflightIssueDismissed('gh', reAdded)).toBe(true)
  })

  it('tracks dismissals independently per issue id', () => {
    const repos = [gitlabRepo('b')]
    dismissPreflightIssue('gh', repos)
    expect(isPreflightIssueDismissed('gh', repos)).toBe(true)
    expect(isPreflightIssueDismissed('gh-auth', repos)).toBe(false)
  })

  it('treats a corrupt stored record as not dismissed', () => {
    localStorage.setItem('orca.preflightBanner.dismissed.gh', '{ not json')
    expect(isPreflightIssueDismissed('gh', [gitlabRepo('b')])).toBe(false)
  })
})
