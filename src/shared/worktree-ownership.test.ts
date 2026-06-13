import { describe, expect, it } from 'vitest'
import type { GlobalSettings, Repo, Worktree, WorktreeMeta } from './types'
import {
  buildKnownOrcaWorkspaceLayouts,
  classifyWorktreeOwnership,
  effectiveExternalWorktreeVisibility,
  isLegacyRepoForExternalWorktreeVisibility,
  shouldShowWorktree,
  toDetectedWorktree,
  EXTERNAL_WORKTREE_VISIBILITY_ROLLOUT_AT
} from './worktree-ownership'

const LARGE_WORKSPACE_HISTORY_COUNT = 150_000

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

function makeWorktree(overrides: Partial<Worktree> = {}): Worktree {
  return {
    id: `repo-1::${overrides.path ?? '/repos/app'}`,
    repoId: 'repo-1',
    path: '/repos/app',
    head: 'abc',
    branch: 'refs/heads/main',
    isBare: false,
    isMainWorktree: true,
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

function makeSettings(overrides: Partial<GlobalSettings> = {}): GlobalSettings {
  return {
    workspaceDir: '/orca/workspaces',
    nestWorkspaces: true,
    workspaceDirHistory: [],
    refreshLocalBaseRefOnWorktreeCreate: false,
    localBaseRefSuggestionDismissed: false,
    branchPrefix: 'none',
    branchPrefixCustom: '',
    enableGitHubAttribution: false,
    theme: 'system',
    appFontFamily: 'Geist',
    editorAutoSave: false,
    editorAutoSaveDelayMs: 1000,
    editorMinimapEnabled: false,
    markdownReviewToolsEnabled: true,
    terminalFontSize: 14,
    terminalFontFamily: 'monospace',
    terminalFontWeight: 400,
    terminalLineHeight: 1.2,
    ...overrides
  } as GlobalSettings
}

describe('worktree ownership classification', () => {
  it('treats explicit Orca metadata as managed even outside the workspace root', () => {
    const repo = makeRepo()
    const settings = makeSettings()
    expect(
      classifyWorktreeOwnership({
        repo,
        settings,
        worktree: makeWorktree({ path: '/tmp/outside' }),
        meta: makeMeta({ orcaCreatedAt: 1 }),
        knownOrcaLayouts: buildKnownOrcaWorkspaceLayouts(settings, repo)
      })
    ).toBe('orca-managed')
  })

  it('requires the nested repo-specific path shape for path-only ownership', () => {
    const repo = makeRepo()
    const settings = makeSettings()
    const layouts = buildKnownOrcaWorkspaceLayouts(settings, repo)
    expect(
      classifyWorktreeOwnership({
        repo,
        settings,
        worktree: makeWorktree({ path: '/orca/workspaces/app/feature' }),
        knownOrcaLayouts: layouts
      })
    ).toBe('orca-managed')
    expect(
      classifyWorktreeOwnership({
        repo,
        settings,
        worktree: makeWorktree({ path: '/orca/workspaces/other/feature' }),
        knownOrcaLayouts: layouts
      })
    ).toBe('external')
  })

  it('treats flat workspace-root descendants as unknown legacy without strong metadata', () => {
    const repo = makeRepo()
    const settings = makeSettings({ nestWorkspaces: false })
    expect(
      classifyWorktreeOwnership({
        repo,
        settings,
        worktree: makeWorktree({ path: '/orca/workspaces/feature' }),
        knownOrcaLayouts: buildKnownOrcaWorkspaceLayouts(settings, repo)
      })
    ).toBe('unknown-legacy')
  })

  it('keeps flat-layout history weak after switching the same root to nested mode', () => {
    const repo = makeRepo()
    const settings = makeSettings({
      nestWorkspaces: true,
      workspaceDirHistory: [{ path: '/orca/workspaces', nestWorkspaces: false }]
    })
    expect(
      classifyWorktreeOwnership({
        repo,
        settings,
        worktree: makeWorktree({ path: '/orca/workspaces/feature' }),
        knownOrcaLayouts: buildKnownOrcaWorkspaceLayouts(settings, repo)
      })
    ).toBe('unknown-legacy')
  })

  it('uses each historical layout nest mode when matching old roots', () => {
    const repo = makeRepo()
    const settings = makeSettings({
      workspaceDir: '/new/workspaces',
      workspaceDirHistory: [{ path: '/old/workspaces', nestWorkspaces: true }]
    })
    expect(
      classifyWorktreeOwnership({
        repo,
        settings,
        worktree: makeWorktree({ path: '/old/workspaces/app/feature' }),
        knownOrcaLayouts: buildKnownOrcaWorkspaceLayouts(settings, repo)
      })
    ).toBe('orca-managed')
  })

  it('builds known layouts from large workspace history lists', () => {
    const repo = makeRepo()
    const workspaceDirHistory = Array.from(
      { length: LARGE_WORKSPACE_HISTORY_COUNT },
      (_, index) => ({
        path: `/history/workspaces-${index}`,
        nestWorkspaces: index % 2 === 0
      })
    )
    const settings = makeSettings({
      workspaceDir: '/new/workspaces',
      workspaceDirHistory
    })

    const layouts = buildKnownOrcaWorkspaceLayouts(settings, repo)

    expect(layouts).toHaveLength(LARGE_WORKSPACE_HISTORY_COUNT + 1)
    expect(layouts[0]).toEqual({ path: '/new/workspaces', nestWorkspaces: true })
    expect(layouts[1]).toEqual({ path: '/history/workspaces-0', nestWorkspaces: true })
    expect(layouts.at(-1)).toEqual({
      path: `/history/workspaces-${LARGE_WORKSPACE_HISTORY_COUNT - 1}`,
      nestWorkspaces: false
    })
  })

  it('handles Windows drive casing and separators', () => {
    const repo = makeRepo({ path: 'C:\\repos\\App' })
    const settings = makeSettings({ workspaceDir: 'C:\\Orca\\Workspaces' })
    expect(
      classifyWorktreeOwnership({
        repo,
        settings,
        worktree: makeWorktree({
          id: 'repo-1::C:\\ORCA\\WORKSPACES\\App\\Feature',
          path: 'C:\\ORCA\\WORKSPACES\\App\\Feature',
          isMainWorktree: false
        }),
        knownOrcaLayouts: buildKnownOrcaWorkspaceLayouts(settings, repo)
      })
    ).toBe('orca-managed')
  })

  it('keeps selected linked checkouts visible without trusting Git main-worktree', () => {
    const repo = makeRepo({ path: '/repos/app-linked', externalWorktreeVisibility: 'hide' })
    const settings = makeSettings()
    const selected = toDetectedWorktree({
      repo,
      settings,
      worktree: makeWorktree({
        path: '/repos/app-linked',
        isMainWorktree: false
      }),
      knownOrcaLayouts: buildKnownOrcaWorkspaceLayouts(settings, repo)
    })
    const gitMain = toDetectedWorktree({
      repo,
      settings,
      worktree: makeWorktree({
        path: '/repos/app-main',
        isMainWorktree: true
      }),
      knownOrcaLayouts: buildKnownOrcaWorkspaceLayouts(settings, repo)
    })

    expect(selected.visible).toBe(true)
    expect(gitMain.visible).toBe(false)
    expect(gitMain.ownership).toBe('external')
  })
})

describe('external worktree visibility policy', () => {
  it('defaults undefined visibility to hide for new repos and show for legacy repos', () => {
    expect(effectiveExternalWorktreeVisibility(makeRepo(), false)).toBe('hide')
    expect(effectiveExternalWorktreeVisibility(makeRepo(), true)).toBe('show')
  })

  it('treats persisted repos without explicit visibility as legacy for upgrade safety', () => {
    expect(isLegacyRepoForExternalWorktreeVisibility(makeRepo())).toBe(true)
  })

  it('computes legacy status from rollout timing, not from the stored visibility value', () => {
    expect(
      isLegacyRepoForExternalWorktreeVisibility(
        makeRepo({
          addedAt: EXTERNAL_WORKTREE_VISIBILITY_ROLLOUT_AT - 1,
          externalWorktreeVisibility: 'hide'
        })
      )
    ).toBe(true)
  })

  it('honors an explicit legacy marker after visibility changes', () => {
    expect(
      isLegacyRepoForExternalWorktreeVisibility(
        makeRepo({
          externalWorktreeVisibility: 'hide',
          externalWorktreeVisibilityLegacy: true
        })
      )
    ).toBe(true)
    expect(
      isLegacyRepoForExternalWorktreeVisibility(
        makeRepo({
          externalWorktreeVisibility: 'hide',
          externalWorktreeVisibilityLegacy: false
        })
      )
    ).toBe(false)
  })

  it('treats repos without a valid addedAt as legacy for upgrade safety', () => {
    expect(
      isLegacyRepoForExternalWorktreeVisibility(makeRepo({ addedAt: undefined as never }))
    ).toBe(true)
    expect(isLegacyRepoForExternalWorktreeVisibility(makeRepo({ addedAt: Number.NaN }))).toBe(true)
  })

  it('keeps unknown legacy rows visible for legacy repos after hiding external rows', () => {
    const repo = makeRepo({
      addedAt: EXTERNAL_WORKTREE_VISIBILITY_ROLLOUT_AT - 1,
      externalWorktreeVisibility: 'hide'
    })
    expect(
      shouldShowWorktree({
        repo,
        worktree: makeWorktree({ path: '/orca/workspaces/feature' }),
        ownership: 'unknown-legacy',
        isLegacyRepoForVisibility: true,
        isSelectedCheckout: false
      })
    ).toBe(true)
  })
})
