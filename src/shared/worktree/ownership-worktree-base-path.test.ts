import { describe, expect, it } from 'vitest'
import type { GlobalSettings } from '../global-settings-types'
import type { Repo } from '../repo-types'
import type { Worktree } from './types'
import { buildKnownOrcaWorkspaceLayouts, classifyWorktreeOwnership } from './ownership'

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
  it('lets an explicitly configured Claude base outrank the built-in scratch path', () => {
    const repo = makeRepo({ worktreeBasePath: '.claude/worktrees' })
    const settings = makeSettings()
    const worktree = makeWorktree('/projects/a/repo/.claude/worktrees/repo/feature')

    expect(
      classifyWorktreeOwnership({
        repo,
        settings,
        worktree,
        knownOrcaLayouts: buildKnownOrcaWorkspaceLayouts(settings, repo)
      })
    ).toBe('external')
  })

  it('keeps the same path classified as scratch without the explicit base', () => {
    const repo = makeRepo()
    const settings = makeSettings()
    expect(
      classifyWorktreeOwnership({
        repo,
        settings,
        worktree: makeWorktree('/projects/a/repo/.claude/worktrees/repo/feature'),
        knownOrcaLayouts: buildKnownOrcaWorkspaceLayouts(settings, repo)
      })
    ).toBe('agent-scratch')
  })

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
    ).toBe('external')
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
    ).toBe('external')
  })

  it('resolves an absolute Linux base path of a WSL repo into its distro layout (STA-4772)', () => {
    const repo = makeRepo({
      path: '\\\\wsl.localhost\\Ubuntu-24.04\\home\\jin\\src\\repo',
      worktreeBasePath: '/home/jin/src/.orca-worktrees'
    })
    const settings = makeSettings({ workspaceDir: 'C:\\global' })
    const layouts = buildKnownOrcaWorkspaceLayouts(settings, repo)

    expect(layouts[0]).toEqual({
      path: '//wsl.localhost/Ubuntu-24.04/home/jin/src/.orca-worktrees',
      nestWorkspaces: true
    })
    expect(
      classifyWorktreeOwnership({
        repo,
        settings,
        worktree: makeWorktree(
          '\\\\wsl.localhost\\Ubuntu-24.04\\home\\jin\\src\\.orca-worktrees\\repo\\feature'
        ),
        knownOrcaLayouts: layouts
      })
    ).toBe('external')
  })

  it('classifies worktrees under a dotted Linux base exactly where creation collapses it', () => {
    const repo = makeRepo({
      path: '\\\\wsl.localhost\\Ubuntu-24.04\\home\\jin\\src\\repo',
      worktreeBasePath: '/home/jin/src/../.orca-worktrees'
    })
    const settings = makeSettings({ workspaceDir: 'C:\\global' })
    const layouts = buildKnownOrcaWorkspaceLayouts(settings, repo)

    expect(layouts[0]).toEqual({
      path: '//wsl.localhost/Ubuntu-24.04/home/jin/.orca-worktrees',
      nestWorkspaces: true
    })
    expect(
      classifyWorktreeOwnership({
        repo,
        settings,
        worktree: makeWorktree(
          '\\\\wsl.localhost\\Ubuntu-24.04\\home\\jin\\.orca-worktrees\\repo\\feature'
        ),
        knownOrcaLayouts: layouts
      })
    ).toBe('external')
  })

  it('preserves mixed-case WSL paths while resolving the configured base', () => {
    const repo = makeRepo({
      path: '\\\\wsl.localhost\\Ubuntu-24.04\\home\\Dev\\Repo',
      worktreeBasePath: '/home/Dev/Repo/.claude/worktrees'
    })
    const settings = makeSettings({ workspaceDir: 'C:\\global' })

    expect(
      classifyWorktreeOwnership({
        repo,
        settings,
        worktree: makeWorktree(
          '\\\\wsl.localhost\\Ubuntu-24.04\\home\\Dev\\Repo\\.claude\\worktrees\\feature'
        ),
        knownOrcaLayouts: buildKnownOrcaWorkspaceLayouts(settings, repo)
      })
    ).toBe('external')
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
