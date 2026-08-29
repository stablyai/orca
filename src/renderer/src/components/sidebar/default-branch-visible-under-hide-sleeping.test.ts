import { describe, expect, it } from 'vitest'
import { computeVisibleWorktreeIds, type SidebarFilterState } from './visible-worktrees'
import { isDefaultBranchWorkspace } from './default-branch-workspace'
import type { Repo } from '../../../../shared/repo-types'
import type { Worktree } from '../../../../shared/worktree/types'
import { LOCAL_EXECUTION_HOST_ID } from '../../../../shared/execution-host'

/**
 * Repro for #8873 — "[Feature]: Display default branch".
 *
 * Reporter: turning "Hide default branch" OFF does not keep the repo's
 * default-branch workspace in the sidebar; once it has no live PTY/browser/agent
 * it counts as sleeping and "Hide sleeping" sweeps it away. There is no
 * "Always display default branch" escape hatch.
 */

function makeRepo(id: string): Repo {
  return { id, path: `/${id}`, displayName: id, badgeColor: '#000', addedAt: 0 }
}

function makeDefaultBranchWorktree(): Worktree {
  return {
    id: 'wt-main',
    repoId: 'repo1',
    path: '/tmp/repo1',
    head: 'abc123',
    branch: 'refs/heads/main',
    isBare: false,
    isMainWorktree: true,
    displayName: 'main',
    comment: '',
    linkedIssue: null,
    linkedPR: null,
    linkedLinearIssue: null,
    isArchived: false,
    isUnread: false,
    isPinned: false,
    sortOrder: 0,
    lastActivityAt: 0
  }
}

const repoMap = new Map<string, Repo>([['repo1', makeRepo('repo1')]])

type VisibleOptions = Parameters<typeof computeVisibleWorktreeIds>[2]

function visibleOptions(overrides: Partial<VisibleOptions> = {}): VisibleOptions {
  return {
    filterRepoIds: [],
    showSleepingWorkspaces: true,
    tabsByWorktree: {},
    ptyIdsByTabId: {},
    browserTabsByWorktree: {},
    worktreeIdsWithLiveAgent: new Set(),
    hideDefaultBranchWorkspace: false,
    hideAutomationGeneratedWorkspaces: false,
    hideCliCreatedWorkspaces: false,
    hideDetachedHeadWorkspaces: false,
    hideWorkspacesFromOtherDevices: false,
    pairedDeviceIdsByEnvironment: new Map(),
    repoMap,
    workspaceHostScope: 'all',
    defaultHostId: LOCAL_EXECUTION_HOST_ID,
    worktreeLineageById: {},
    ...overrides
  }
}

describe('#8873 default-branch workspace under "Hide sleeping"', () => {
  it('is genuinely the default-branch row the "Hide default branch" toggle targets', () => {
    expect(isDefaultBranchWorkspace(makeDefaultBranchWorktree())).toBe(true)
  })

  it('stays in the sidebar when it is sleeping and "Hide sleeping" is on', () => {
    const worktree = makeDefaultBranchWorktree()

    const visible = computeVisibleWorktreeIds({ repo1: [worktree] }, [worktree.id], {
      ...visibleOptions({
        // "Hide sleeping" ON, "Hide default branch" OFF — exactly the reporter's setup.
        showSleepingWorkspaces: false,
        hideDefaultBranchWorkspace: false
      })
    })

    expect(visible).toEqual([worktree.id])
  })

  it('exposes an opt-in that keeps the default branch visible under "Hide sleeping"', () => {
    // The issue asks for an "Always display default branch" flag. Prove the
    // sidebar filter contract has no such knob today.
    const filterKeys: readonly (keyof SidebarFilterState)[] = [
      'showSleepingWorkspaces',
      'filterRepoIds',
      'hideDefaultBranchWorkspace',
      'hideAutomationGeneratedWorkspaces',
      'hideCliCreatedWorkspaces',
      'hideDetachedHeadWorkspaces',
      'hideWorkspacesFromOtherDevices',
      'alwaysShowDefaultBranchWorkspace',
      'visibleWorkspaceHostIds',
      'workspaceHostScope'
    ]
    const optionKeys = Object.keys(visibleOptions())

    const alwaysShowKnob = [...filterKeys, ...optionKeys].find((key) =>
      /always.*default|default.*always|pinDefaultBranch/i.test(key)
    )

    expect(alwaysShowKnob).toBeDefined()
  })
})

describe('the "Hide sleeping" exemption for project entry-point rows', () => {
  function visible(worktrees: Worktree[], overrides: Partial<VisibleOptions>): string[] {
    return computeVisibleWorktreeIds(
      { repo1: worktrees },
      worktrees.map((w) => w.id),
      visibleOptions({ showSleepingWorkspaces: false, ...overrides })
    )
  }

  it('re-hides the sleeping default branch when the user opts out', () => {
    const worktree = makeDefaultBranchWorktree()

    expect(visible([worktree], { alwaysShowDefaultBranchWorkspace: false })).toEqual([])
  })

  it('keeps the sleeping default branch when the option is explicitly on', () => {
    const worktree = makeDefaultBranchWorktree()

    expect(visible([worktree], { alwaysShowDefaultBranchWorkspace: true })).toEqual([worktree.id])
  })

  it('lets an explicit "Hide default branch" still win over the exemption', () => {
    const worktree = makeDefaultBranchWorktree()

    expect(
      visible([worktree], {
        hideDefaultBranchWorkspace: true,
        alwaysShowDefaultBranchWorkspace: true
      })
    ).toEqual([])
  })

  it('still sweeps sleeping non-main workspaces', () => {
    const feature: Worktree = {
      ...makeDefaultBranchWorktree(),
      id: 'wt-feature',
      branch: 'refs/heads/feature',
      isMainWorktree: false
    }

    expect(visible([feature], { alwaysShowDefaultBranchWorkspace: true })).toEqual([])
  })

  it('keeps a sleeping folder workspace, which has no sibling row to fall back to', () => {
    // Folder-mode projects are main worktrees with an empty branch/head, so the
    // default-branch predicate rejects them; sweeping them drops the whole project.
    const folder: Worktree = {
      ...makeDefaultBranchWorktree(),
      id: 'wt-folder',
      branch: '',
      head: ''
    }
    expect(isDefaultBranchWorkspace(folder)).toBe(false)

    expect(visible([folder], { alwaysShowDefaultBranchWorkspace: true })).toEqual([folder.id])
  })

  it('keeps a sleeping detached-HEAD main worktree', () => {
    const detachedMain: Worktree = { ...makeDefaultBranchWorktree(), id: 'wt-detached', branch: '' }

    expect(visible([detachedMain], { alwaysShowDefaultBranchWorkspace: true })).toEqual([
      detachedMain.id
    ])
  })

  it('lets "Hide detached HEAD" still win over the exemption', () => {
    const detachedMain: Worktree = { ...makeDefaultBranchWorktree(), id: 'wt-detached', branch: '' }

    expect(
      visible([detachedMain], {
        hideDetachedHeadWorkspaces: true,
        alwaysShowDefaultBranchWorkspace: true
      })
    ).toEqual([])
  })

  it('keeps every project’s entry point, not just the first', () => {
    const mainA = makeDefaultBranchWorktree()
    const mainB: Worktree = { ...makeDefaultBranchWorktree(), id: 'wt-main-b' }

    expect(visible([mainA, mainB], {})).toEqual([mainA.id, mainB.id])
  })

  it('does not flicker out while an SSH host is offline', () => {
    // A disconnected SSH provider re-synthesizes persisted worktrees with empty
    // head/branch (orca-runtime.ts) while isMainWorktree stays a path compare —
    // and the dead PTYs make the row read as sleeping at exactly that moment.
    const awake = makeDefaultBranchWorktree()
    const offline: Worktree = { ...awake, head: '', branch: '' }

    expect(visible([offline], {})).toEqual([offline.id])
    expect(visible([awake], {})).toEqual([awake.id])
  })
})
