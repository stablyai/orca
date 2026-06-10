import { describe, expect, it } from 'vitest'
import type { GlobalSettings, Repo, Worktree, WorktreeMeta } from './types'
import {
  buildKnownOrcaWorkspaceLayouts,
  classifyWorktreeOwnership,
  EXTERNAL_WORKTREE_VISIBILITY_ROLLOUT_AT
} from './worktree-ownership'

function makeRepo(overrides: Partial<Repo> = {}): Repo {
  return {
    id: 'repo-1',
    path: '/repos/app',
    displayName: 'app',
    badgeColor: '#000',
    addedAt: EXTERNAL_WORKTREE_VISIBILITY_ROLLOUT_AT + 1,
    kind: 'git',
    ...overrides
  }
}

function makeSettings(overrides: Partial<GlobalSettings> = {}): GlobalSettings {
  return {
    workspaceDir: '/orca/workspaces',
    nestWorkspaces: true,
    workspaceDirHistory: [],
    refreshLocalBaseRefOnWorktreeCreate: false,
    branchPrefix: 'none',
    branchPrefixCustom: '',
    enableGitHubAttribution: false,
    ...overrides
  } as GlobalSettings
}

function makeWorktree(overrides: Partial<Worktree>): Worktree {
  return {
    id: `repo-1::${overrides.path}`,
    repoId: 'repo-1',
    path: '/repos/app',
    head: 'abc',
    branch: 'refs/heads/main',
    isBare: false,
    isMainWorktree: false,
    displayName: 'main',
    comment: '',
    linkedIssue: null,
    linkedPR: null,
    linkedLinearIssue: null,
    linkedGitLabMR: null,
    linkedGitLabIssue: null,
    isArchived: false,
    isUnread: false,
    isPinned: false,
    sortOrder: 0,
    lastActivityAt: 0,
    workspaceStatus: 'todo',
    ...overrides
  }
}

function makeMeta(overrides: Partial<WorktreeMeta> = {}): WorktreeMeta {
  return {
    displayName: '',
    comment: '',
    linkedIssue: null,
    linkedPR: null,
    linkedLinearIssue: null,
    linkedGitLabMR: null,
    linkedGitLabIssue: null,
    isArchived: false,
    isUnread: false,
    isPinned: false,
    sortOrder: 0,
    lastActivityAt: 0,
    workspaceStatus: 'todo',
    ...overrides
  }
}

describe('worktree ownership project folder overrides', () => {
  it('adds local project folder overrides as flat known roots', () => {
    const repo = makeRepo({ worktreeFolderPath: '/project-worktrees' })
    const settings = makeSettings()
    const layouts = buildKnownOrcaWorkspaceLayouts(settings, repo)

    expect(layouts).toContainEqual({ path: '/project-worktrees', nestWorkspaces: false })
    expect(
      classifyWorktreeOwnership({
        repo,
        settings,
        worktree: makeWorktree({ path: '/project-worktrees/existing-external' }),
        knownOrcaLayouts: layouts
      })
    ).toBe('unknown-legacy')
    expect(
      classifyWorktreeOwnership({
        repo,
        settings,
        worktree: makeWorktree({ path: '/project-worktrees/new-managed' }),
        meta: makeMeta({ orcaCreatedAt: 1 }),
        knownOrcaLayouts: layouts
      })
    ).toBe('orca-managed')
  })

  it('does not add SSH project folder overrides to local ownership layouts', () => {
    const layouts = buildKnownOrcaWorkspaceLayouts(
      makeSettings(),
      makeRepo({ connectionId: 'ssh-1', worktreeFolderPath: '/remote/worktrees' })
    )

    expect(layouts).not.toContainEqual({ path: '/remote/worktrees', nestWorkspaces: false })
  })
})
