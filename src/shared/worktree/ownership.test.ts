import { describe, expect, it } from 'vitest'
import type { GlobalSettings } from '../global-settings-types'
import type { Repo } from '../repo-types'
import type { WorktreeMeta } from './meta-types'
import type { Worktree } from './types'

import { migrateExternalWorktreeVisibilityDefaults } from '../external-worktree-visibility'
import {
  applyMetadataFallbackVisibility,
  buildKnownOrcaWorkspaceLayouts,
  classifyWorktreeOwnership,
  shouldShowWorktree,
  toDetectedWorktree,
  EXTERNAL_WORKTREE_VISIBILITY_ROLLOUT_AT
} from './ownership'

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
  it('does not treat generic discovery metadata on nested workspace paths as Orca-managed', () => {
    const repo = makeRepo({ externalWorktreeVisibility: 'hide' })
    const settings = makeSettings()
    const detected = toDetectedWorktree({
      repo,
      settings,
      worktree: makeWorktree({
        path: '/orca/workspaces/app/manual-git-worktree',
        isMainWorktree: false
      }),
      meta: makeMeta({ displayName: 'manual-git-worktree' }),
      knownOrcaLayouts: buildKnownOrcaWorkspaceLayouts(settings, repo)
    })

    expect(detected.ownership).toBe('external')
    expect(detected.visible).toBe(false)
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
  it('materializes only implicit legacy visibility when adding the safe global default', () => {
    const legacy = makeRepo({ externalWorktreeVisibilityLegacy: undefined })
    const explicit = makeRepo({ id: 'explicit', externalWorktreeVisibility: 'hide' })
    const inherited = makeRepo({ id: 'inherited', externalWorktreeVisibilityLegacy: false })

    const migrated = migrateExternalWorktreeVisibilityDefaults(
      [legacy, explicit, inherited],
      undefined
    )

    expect(migrated.defaults).toEqual({ external: 'hide' })
    expect(migrated.repos).toEqual([
      expect.objectContaining({
        id: legacy.id,
        externalWorktreeVisibility: 'show',
        externalWorktreeVisibilityLegacy: true
      }),
      explicit,
      inherited
    ])
    expect(
      migrateExternalWorktreeVisibilityDefaults(migrated.repos, migrated.defaults).changed
    ).toBe(false)
  })

  it('does not materialize visibility on folder repositories', () => {
    const folder = makeRepo({ kind: 'folder', externalWorktreeVisibilityLegacy: undefined })
    const migrated = migrateExternalWorktreeVisibilityDefaults([folder], undefined)

    expect(migrated.repos[0]?.externalWorktreeVisibility).toBeUndefined()
  })

  it('materializes legacy visibility on persisted repositories without a kind', () => {
    const legacy = makeRepo({ kind: undefined, externalWorktreeVisibilityLegacy: undefined })
    const migrated = migrateExternalWorktreeVisibilityDefaults([legacy], undefined)

    expect(migrated.repos[0]?.externalWorktreeVisibility).toBe('show')
  })

  it('shows explicitly imported external worktrees while repo visibility stays hide', () => {
    const repo = makeRepo({
      externalWorktreeVisibility: 'hide',
      importedExternalWorktreePaths: ['/scratch/imported']
    })
    expect(
      shouldShowWorktree({
        repo,
        worktree: makeWorktree({ path: '/scratch/imported', isMainWorktree: false }),
        ownership: 'external',
        isLegacyRepoForVisibility: false,
        isSelectedCheckout: false,
        importedExternalWorktreePaths: repo.importedExternalWorktreePaths
      })
    ).toBe(true)
    expect(
      shouldShowWorktree({
        repo,
        worktree: makeWorktree({ path: '/scratch/other', isMainWorktree: false }),
        ownership: 'external',
        isLegacyRepoForVisibility: false,
        isSelectedCheckout: false,
        importedExternalWorktreePaths: repo.importedExternalWorktreePaths
      })
    ).toBe(false)
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

describe('agent scratch worktrees', () => {
  const scratchPath = '/repos/app/.claude/worktrees/agent-a04ccaaa55ddadb91'

  it('keeps strong Orca metadata authoritative over the scratch path match', () => {
    const repo = makeRepo()
    const settings = makeSettings()
    expect(
      classifyWorktreeOwnership({
        repo,
        settings,
        worktree: makeWorktree({ path: scratchPath, isMainWorktree: false }),
        meta: makeMeta({ orcaCreatedAt: 1 }),
        knownOrcaLayouts: buildKnownOrcaWorkspaceLayouts(settings, repo)
      })
    ).toBe('orca-managed')
  })

  it('keeps agent scratch hidden by default for new and legacy repos', () => {
    for (const repo of [
      makeRepo({ externalWorktreeVisibility: 'show' }),
      makeRepo({ addedAt: EXTERNAL_WORKTREE_VISIBILITY_ROLLOUT_AT - 1 })
    ]) {
      const settings = makeSettings()
      const detected = toDetectedWorktree({
        repo,
        settings,
        worktree: makeWorktree({ path: scratchPath, isMainWorktree: false }),
        knownOrcaLayouts: buildKnownOrcaWorkspaceLayouts(settings, repo)
      })
      expect(detected.ownership).toBe('agent-scratch')
      expect(detected.visible).toBe(false)
    }
  })

  it('applies built-in source preferences independently after legacy migration', () => {
    const repo = makeRepo({
      agentWorktreeVisibility: 'show',
      worktreeVisibilitySourcePreferences: {
        builtIn: { claude: 'hide', gsd: 'show' }
      }
    })
    const settings = makeSettings()

    expect(
      toDetectedWorktree({
        repo,
        settings,
        worktree: makeWorktree({ path: scratchPath, isMainWorktree: false }),
        knownOrcaLayouts: buildKnownOrcaWorkspaceLayouts(settings, repo)
      }).visible
    ).toBe(false)
    expect(
      toDetectedWorktree({
        repo,
        settings,
        worktree: makeWorktree({
          path: '/repos/app/.gsd-workspaces/phase-1',
          isMainWorktree: false
        }),
        knownOrcaLayouts: buildKnownOrcaWorkspaceLayouts(settings, repo)
      }).visible
    ).toBe(true)
  })

  it('lets a custom source override ordinary external visibility', () => {
    const customPath = '/srv/team-worktrees/feature'
    const repo = makeRepo({
      externalWorktreeVisibility: 'show',
      customWorktreeVisibilitySources: [{ id: 'team', rootPath: '/srv/team-worktrees' }],
      worktreeVisibilitySourcePreferences: { custom: { team: 'hide' } }
    })
    const settings = makeSettings()
    const detected = toDetectedWorktree({
      repo,
      settings,
      worktree: makeWorktree({ path: customPath, isMainWorktree: false }),
      knownOrcaLayouts: buildKnownOrcaWorkspaceLayouts(settings, repo)
    })

    expect(detected.visibilitySource).toEqual({ kind: 'custom', id: 'team' })
    expect(detected.visible).toBe(false)
    expect(applyMetadataFallbackVisibility(detected).visible).toBe(false)
  })

  it('keeps agent scratch hidden in the metadata fallback while revealing the rest', () => {
    const repo = makeRepo()
    const settings = makeSettings()
    const layouts = buildKnownOrcaWorkspaceLayouts(settings, repo)
    const scratch = toDetectedWorktree({
      repo,
      settings,
      worktree: makeWorktree({ path: scratchPath, isMainWorktree: false }),
      knownOrcaLayouts: layouts
    })
    const external = toDetectedWorktree({
      repo,
      settings,
      worktree: makeWorktree({ path: '/scratch/manual', isMainWorktree: false }),
      knownOrcaLayouts: layouts
    })

    expect(applyMetadataFallbackVisibility(scratch)).toMatchObject({
      visible: false,
      ownership: 'agent-scratch'
    })
    expect(applyMetadataFallbackVisibility(external)).toMatchObject({
      visible: true,
      ownership: 'unknown-legacy'
    })
  })

  it('preserves an explicit scratch import in the metadata fallback', () => {
    const repo = makeRepo({
      externalWorktreeVisibility: 'hide',
      importedExternalWorktreePaths: [scratchPath]
    })
    const settings = makeSettings()
    const scratch = toDetectedWorktree({
      repo,
      settings,
      worktree: makeWorktree({ path: scratchPath, isMainWorktree: false }),
      knownOrcaLayouts: buildKnownOrcaWorkspaceLayouts(settings, repo)
    })

    expect(scratch).toMatchObject({ ownership: 'agent-scratch', visible: true })
    expect(applyMetadataFallbackVisibility(scratch)).toBe(scratch)
  })

  it('does not classify worktrees from a repo stored below a scratch-looking parent', () => {
    const repo = makeRepo({ path: '/repos/.claude/worktrees/app' })
    const settings = makeSettings()

    expect(
      classifyWorktreeOwnership({
        repo,
        settings,
        worktree: makeWorktree({
          path: '/repos/.claude/worktrees/app/manual/feature-x',
          isMainWorktree: false
        }),
        knownOrcaLayouts: buildKnownOrcaWorkspaceLayouts(settings, repo)
      })
    ).not.toBe('agent-scratch')
  })
})
