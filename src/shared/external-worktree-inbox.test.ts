import { describe, expect, it } from 'vitest'

import type {
  DetectedWorktree,
  DetectedWorktreeListResult,
  GlobalSettings,
  Repo,
  Worktree
} from './types'
import {
  getHiddenExternalWorktrees,
  getNewExternalWorktreeInboxWorktrees,
  getVisibleExternalWorktrees,
  mergeExternalWorktreeInboxPaths,
  shouldOfferNewExternalWorktreeInbox
} from './external-worktree-inbox'
import {
  buildKnownOrcaWorkspaceLayouts,
  EXTERNAL_WORKTREE_VISIBILITY_ROLLOUT_AT,
  toDetectedWorktree
} from './worktree-ownership'

const repo: Repo = {
  id: 'repo-1',
  path: '/repo',
  displayName: 'orca',
  badgeColor: '#000000',
  addedAt: Date.UTC(2026, 4, 24),
  externalWorktreeVisibility: 'hide',
  externalWorktreeVisibilityPromptDismissedAt: 1
}

function detectedWorktree(overrides: Partial<DetectedWorktree> = {}): DetectedWorktree {
  return {
    id: 'repo-1::/repo-worktree',
    repoId: repo.id,
    path: '/repo-worktree',
    displayName: 'repo-worktree',
    branch: 'refs/heads/feature',
    head: 'abc123',
    isBare: false,
    isMainWorktree: false,
    comment: '',
    linkedIssue: null,
    linkedPR: null,
    linkedLinearIssue: null,
    isArchived: false,
    isUnread: false,
    isPinned: false,
    sortOrder: 0,
    lastActivityAt: 0,
    ownership: 'external',
    selectedCheckout: false,
    visible: false,
    ...overrides
  }
}

function detectedResult(worktrees: DetectedWorktree[]): DetectedWorktreeListResult {
  return {
    repoId: repo.id,
    authoritative: true,
    source: 'git',
    worktrees
  }
}

function makeSettings(): GlobalSettings {
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
    terminalLineHeight: 1.2
  } as unknown as GlobalSettings
}

function makeGitWorktree(overrides: Partial<Worktree> = {}): Worktree {
  return {
    id: `repo-1::${overrides.path ?? '/repo'}`,
    repoId: repo.id,
    path: '/repo',
    displayName: 'repo',
    branch: 'refs/heads/main',
    head: 'abc123',
    isBare: false,
    isMainWorktree: true,
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

describe('external worktree inbox', () => {
  it('merges inbox paths without duplicates when paths match after normalization', () => {
    expect(mergeExternalWorktreeInboxPaths(['/repo/one/'], ['/repo/one', '/repo/two'])).toEqual([
      '/repo/one/',
      '/repo/two'
    ])
  })

  it('offers the inbox only after the initial prompt is dismissed and discovery is not suppressed', () => {
    expect(shouldOfferNewExternalWorktreeInbox(repo)).toBe(true)
    expect(
      shouldOfferNewExternalWorktreeInbox({
        ...repo,
        externalWorktreeVisibilityPromptDismissedAt: undefined
      })
    ).toBe(false)
    expect(
      shouldOfferNewExternalWorktreeInbox({
        ...repo,
        externalWorktreeDiscoverySuppressedAt: 1
      })
    ).toBe(false)
    expect(
      shouldOfferNewExternalWorktreeInbox({
        ...repo,
        externalWorktreeVisibility: 'show'
      })
    ).toBe(false)
  })

  it('returns only hidden external worktrees outside the inbox baseline', () => {
    const hidden = detectedWorktree({ id: 'hidden', path: '/scratch/new-one' })
    const baselined = detectedWorktree({ id: 'baselined', path: '/scratch/old-one' })
    const detected = detectedResult([
      hidden,
      baselined,
      detectedWorktree({ id: 'visible', visible: true }),
      detectedWorktree({ id: 'orca-managed', ownership: 'orca-managed' })
    ])

    expect(getHiddenExternalWorktrees(detected)).toEqual([hidden, baselined])
    expect(
      getNewExternalWorktreeInboxWorktrees(detected, {
        ...repo,
        externalWorktreeInboxBaselinePaths: ['/scratch/old-one']
      })
    ).toEqual([hidden])
  })

  it('excludes explicitly visible agent scratch from visibility-control counts', () => {
    const visible = detectedWorktree({ id: 'visible', visible: true })
    const scratch = detectedWorktree({
      id: 'agent-scratch',
      ownership: 'agent-scratch',
      visible: true
    })

    expect(getVisibleExternalWorktrees(detectedResult([visible, scratch]))).toEqual([visible])
  })

  it('offers metadata-free nested Orca workspace worktrees through the inbox', () => {
    const settings = makeSettings()
    const manual = toDetectedWorktree({
      repo,
      settings,
      worktree: makeGitWorktree({
        path: '/orca/workspaces/orca/manual-from-git',
        displayName: 'manual-from-git',
        branch: 'refs/heads/manual-from-git',
        isMainWorktree: false
      }),
      knownOrcaLayouts: buildKnownOrcaWorkspaceLayouts(settings, repo)
    })

    expect(manual.ownership).toBe('external')
    expect(manual.visible).toBe(false)
    expect(getNewExternalWorktreeInboxWorktrees(detectedResult([manual]), repo)).toEqual([manual])
  })

  it('suppresses non-authoritative detected results', () => {
    expect(
      getNewExternalWorktreeInboxWorktrees(detectedResult([detectedWorktree()]), {
        ...repo,
        addedAt: EXTERNAL_WORKTREE_VISIBILITY_ROLLOUT_AT + 1
      })
    ).toEqual([detectedWorktree()])
    expect(
      getNewExternalWorktreeInboxWorktrees(
        { ...detectedResult([detectedWorktree()]), authoritative: false },
        repo
      )
    ).toEqual([])
  })
})
