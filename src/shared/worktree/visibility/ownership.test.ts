import { describe, expect, it } from 'vitest'
import type { GlobalSettings } from '../../global-settings-types'
import type { Repo } from '../../repo-types'
import type { WorktreeMeta } from '../meta-types'
import type { Worktree } from '../types'

import {
  applyMetadataFallbackVisibility,
  buildKnownOrcaWorkspaceLayouts,
  toDetectedWorktree
} from './ownership'
import { EXTERNAL_WORKTREE_VISIBILITY_ROLLOUT_AT } from '../../external-worktree-visibility'

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

describe('agent scratch worktrees', () => {
  const scratchPath = '/repos/app/.claude/worktrees/agent-a04ccaaa55ddadb91'

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
})
