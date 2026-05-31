import { describe, expect, it } from 'vitest'
import type { GlobalSettings, Repo, Worktree } from './types'
import { buildKnownOrcaWorkspaceLayouts, classifyWorktreeOwnership } from './worktree-ownership'

function makeRepo(overrides: Partial<Repo> = {}): Repo {
  return {
    id: 'repo-1',
    path: '/projects/a/repo',
    displayName: 'repo',
    badgeColor: '#000',
    addedAt: Date.UTC(2026, 4, 24),
    kind: 'git',
    ...overrides
  }
}

function makeWorktree(path: string): Pick<Worktree, 'path' | 'isMainWorktree'> {
  return { path, isMainWorktree: false }
}

function makeSettings(overrides: Partial<GlobalSettings> = {}): GlobalSettings {
  return {
    workspaceDir: '/global/workspaces',
    nestWorkspaces: true,
    workspaceDirHistory: [],
    ...overrides
  } as GlobalSettings
}

describe('repo-specific worktree ownership layouts', () => {
  it('resolves the same relative base path from each repo root', () => {
    const settings = makeSettings()
    const repoA = makeRepo({ path: '/projects/a/repo', worktreeBasePath: '../worktrees' })
    const repoB = makeRepo({ path: '/projects/b/repo', worktreeBasePath: '../worktrees' })

    expect(buildKnownOrcaWorkspaceLayouts(settings, repoA)[0]).toEqual({
      path: '/projects/a/worktrees',
      nestWorkspaces: true
    })
    expect(buildKnownOrcaWorkspaceLayouts(settings, repoB)[0]).toEqual({
      path: '/projects/b/worktrees',
      nestWorkspaces: true
    })
    expect(
      classifyWorktreeOwnership({
        repo: repoA,
        settings,
        worktree: makeWorktree('/projects/a/worktrees/repo/feature'),
        knownOrcaLayouts: buildKnownOrcaWorkspaceLayouts(settings, repoA)
      })
    ).toBe('orca-managed')
    expect(
      classifyWorktreeOwnership({
        repo: repoB,
        settings,
        worktree: makeWorktree('/projects/a/worktrees/repo/feature'),
        knownOrcaLayouts: buildKnownOrcaWorkspaceLayouts(settings, repoB)
      })
    ).toBe('external')
  })

  it('uses repo-specific nested layouts for Windows-style paths', () => {
    const repo = makeRepo({
      path: 'C:\\projects\\App\\repo',
      worktreeBasePath: '..\\worktrees'
    })
    const settings = makeSettings({ workspaceDir: 'D:\\global' })

    expect(
      classifyWorktreeOwnership({
        repo,
        settings,
        worktree: makeWorktree('C:\\projects\\App\\worktrees\\repo\\Feature'),
        knownOrcaLayouts: buildKnownOrcaWorkspaceLayouts(settings, repo)
      })
    ).toBe('orca-managed')
  })

  it('includes relative global layouts for SSH repos without applying absolute desktop paths', () => {
    const repo = makeRepo({ path: '/remote/repo', connectionId: 'ssh-1' })
    const relativeSettings = makeSettings({ workspaceDir: '../worktrees' })
    const absoluteSettings = makeSettings({ workspaceDir: '/local/worktrees' })

    expect(buildKnownOrcaWorkspaceLayouts(relativeSettings, repo)[0]).toEqual({
      path: '/remote/worktrees',
      nestWorkspaces: true
    })
    expect(
      buildKnownOrcaWorkspaceLayouts(absoluteSettings, repo).some(
        (layout) => layout.path === '/local/worktrees'
      )
    ).toBe(false)
  })
})
