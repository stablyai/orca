import { describe, expect, it } from 'vitest'
import type { FolderWorkspace } from '../../../../shared/folder-workspace-types'
import type { MultiRepoMember } from '../../../../shared/multi-repo-workspace'
import type { Repo } from '../../../../shared/repo-types'
import type { Worktree } from '../../../../shared/worktree/types'
import { buildRootPanelModel, REMOVE_AFTER_FAILED_ATTEMPTS } from './root-panel-model'
import {
  getRootPanelHeaderText,
  getRootPanelStatusDetail,
  getRootPanelStatusText
} from './root-panel-copy'

function member(id: string, patch: Partial<MultiRepoMember> = {}): MultiRepoMember {
  return {
    memberId: id,
    repoId: `repo-${id}`,
    dirName: id,
    branchName: 'checkout-flow',
    state: 'ready',
    attempts: 1,
    worktreeId: `wt-${id}`,
    ...patch
  }
}

function workspace(members: MultiRepoMember[], multiRepo = true): FolderWorkspace {
  return {
    id: 'f1',
    projectGroupId: 'g1',
    name: 'checkout-flow',
    folderPath: '/w/f1',
    linkedTask: null,
    comment: '',
    isArchived: false,
    isUnread: false,
    isPinned: false,
    sortOrder: 0,
    lastActivityAt: 0,
    createdAt: 0,
    updatedAt: 0,
    ...(multiRepo
      ? { multiRepo: { version: 1, executionHostId: 'local', rootOwnedByOrca: true, members } }
      : {})
  }
}

// oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: minimal repo fixtures; the model reads only id and displayName.
const repos = ['a', 'b', 'c'].map((id) => ({
  id: `repo-${id}`,
  displayName: id === 'a' ? 'api' : id === 'b' ? 'web' : 'infra'
})) as unknown as Repo[]
const worktrees = Object.fromEntries(
  // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: minimal worktree fixtures; the model reads only id.
  ['a', 'b', 'c'].map((id) => [`repo-${id}`, [{ id: `wt-${id}` }] as unknown as Worktree[]])
)

function build(ws: FolderWorkspace, gitStatusByWorktree = {}) {
  return buildRootPanelModel({
    folderWorkspace: ws,
    repos,
    worktreesByRepo: worktrees,
    gitStatusByWorktree
  })
}

describe('buildRootPanelModel', () => {
  it('is null for a plain folder workspace', () => {
    expect(build(workspace([], false))).toBeNull()
  })

  it('opens ready repos, counts changes and never claims Clean for an unknown status', () => {
    const model = build(workspace([member('a'), member('b'), member('c')]), {
      'wt-a': [{}, {}, {}],
      'wt-b': []
    })
    expect(model?.rows.map((row) => [row.label, row.openKey, row.status])).toEqual([
      ['api', 'wt-a', { kind: 'ready', changedCount: 3 }],
      ['web', 'wt-b', { kind: 'ready', changedCount: 0 }],
      ['infra', 'wt-c', { kind: 'ready', changedCount: null }]
    ])
    expect(getRootPanelStatusText({ kind: 'ready', changedCount: null })).toBe('')
    expect(getRootPanelStatusText({ kind: 'ready', changedCount: 0 })).toBe('Clean')
    expect(getRootPanelHeaderText(model!.summary)).toBe('3 repos · 1 with changes')
  })

  it('offers Retry for failed and interrupted rows, and Remove only after repeated failures', () => {
    const model = build(
      workspace([
        member('a', {
          state: 'failed',
          attempts: 1,
          failure: { code: 'git_failed', message: 'fetch failed', at: 1 },
          worktreeId: undefined
        }),
        member('b', {
          state: 'failed',
          attempts: REMOVE_AFTER_FAILED_ATTEMPTS,
          worktreeId: undefined
        }),
        member('c', { state: 'interrupted', worktreeId: undefined })
      ])
    )
    expect(model?.rows.map((row) => [row.canRetry, row.canRemove, row.openKey])).toEqual([
      [true, false, null],
      [true, true, null],
      [true, false, null]
    ])
    expect(model?.retryAllCount).toBe(3)
    expect(model?.notCreatedLabels).toEqual(['api', 'web', 'infra'])
    expect(getRootPanelStatusText(model!.rows[0].status)).toBe('Git could not create it')
    expect(getRootPanelHeaderText(model!.summary)).toBe('3 repos · 2 failed · 1 interrupted')
  })

  it('shows progress while members are queued or creating, with no Retry', () => {
    const model = build(
      workspace([
        member('a'),
        member('b', { state: 'creating', worktreeId: undefined }),
        member('c', { state: 'queued', worktreeId: undefined })
      ])
    )
    expect(getRootPanelHeaderText(model!.summary)).toBe(
      'Creating 1/3 · 1 with changes'.replace(' · 1 with changes', '')
    )
    expect(model?.rows.filter((row) => row.canRetry)).toHaveLength(0)
  })

  it('marks a missing worktree and a removed project, each removable', () => {
    const ws = workspace([member('a'), member('b')])
    const model = buildRootPanelModel({
      folderWorkspace: ws,
      repos: repos.filter((repo) => repo.id !== 'repo-b'),
      worktreesByRepo: { 'repo-a': [], 'repo-b': [] },
      gitStatusByWorktree: {}
    })
    expect(model?.rows.map((row) => [row.status.kind, row.canRemove, row.openKey])).toEqual([
      ['missing', true, null],
      ['project_removed', true, null]
    ])
  })
})

describe('getRootPanelStatusDetail', () => {
  it('keeps the cause for the tooltip without absolute paths', () => {
    const status = {
      kind: 'failed' as const,
      code: 'git_failed' as const,
      detail:
        "Command failed: git worktree add /Users/me/work/ws/api\nfatal: '/Users/me/work/ws/api' exists"
    }
    expect(getRootPanelStatusText(status)).toBe('Git could not create it')
    const detail = getRootPanelStatusDetail(status)
    expect(detail).toContain('fatal:')
    expect(detail).not.toContain('/Users/me')
  })

  it('has no tooltip for rows that did not fail', () => {
    expect(getRootPanelStatusDetail({ kind: 'creating' })).toBeUndefined()
  })
})
