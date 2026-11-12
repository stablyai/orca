// @vitest-environment happy-dom
// The delete dialog never contacts an asleep Orca Cloud sandbox: no git-status read and no
// ignored-files scan (that would wake the VM, or wait on it, just to fill in a dialog).
import { renderHook } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { Worktree } from '../../../../../../shared/worktree/types'
import type { Repo } from '../../../../../../shared/repo-types'
import type { CloudWorkspaceStatus } from '../../../../../../shared/hosted-sandbox/cloud-workspace-api'
import { seedCloudWorkspaceSnapshot } from '@/lib/orca-cloud/orca-cloud-workspace-store'
import { useDeleteWorktreeStatusHydration } from './use-delete-worktree-status-hydration'
import { useDeleteWorktreeAtRiskLocalFiles } from './use-delete-worktree-at-risk-local-files'
import { mayContactDeleteTargetHost } from './delete-target-host-contact'
import {
  getRuntimeGitStatus,
  getRuntimeWorktreeAtRiskLocalFiles
} from '@/runtime/source-control/git/runtime-git-status-client'

const state = vi.hoisted(() => ({
  repos: [],
  settings: null,
  activeWorktreeId: null,
  activeWorkspaceExecutionHostId: null,
  gitStatusByWorktree: {}
}))
vi.mock('@/store', () => ({
  useAppStore: Object.assign((selector: (value: typeof state) => unknown) => selector(state), {
    getState: () => state
  })
}))
vi.mock('@/runtime/source-control/git/runtime-git-status-client', () => ({
  getRuntimeGitStatus: vi.fn(async () => ({ entries: [] })),
  getRuntimeWorktreeAtRiskLocalFiles: vi.fn(async () => ({
    count: 0,
    samplePaths: [],
    complete: true
  }))
}))
vi.mock('@/runtime/rpc/targets/runtime-client-target', () => ({
  // Every host resolves, so only the cloud guard can stop a read.
  ipcOrRuntimeTargetForHostId: (hostId: string) => ({ kind: 'environment', environmentId: hostId })
}))
vi.mock('@/lib/workspace/ownership/connection-context', () => ({ getConnectionId: () => null }))

const repoMap = new Map<string, Repo>()

function target(id: string): Worktree {
  return {
    id,
    hostId: 'runtime:env-cloud',
    repoId: 'repo',
    path: `/workspace/${id}`,
    displayName: id,
    branch: id,
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
    lastActivityAt: 0
  }
}

function cloudStatus(state: 'ready' | 'sleeping'): CloudWorkspaceStatus {
  return {
    state,
    metrics: null,
    uptimeMs: null,
    usage: { totalMs: 0, centsPerHour: 0, costCents: 0 },
    archive: null,
    checkedAt: 1
  }
}

function seedCloud(id: string, state: 'ready' | 'sleeping'): void {
  seedCloudWorkspaceSnapshot({
    ids: new Set([id]),
    idsLoaded: true,
    status: { [id]: { status: cloudStatus(state), loading: false, error: null, fetchedAt: 1 } }
  })
}

/** Opens the delete dialog's two host reads for one target. */
function openDialogReads(worktree: Worktree): void {
  const targets = [worktree]
  renderHook(() => {
    useDeleteWorktreeStatusHydration({
      isOpen: true,
      deleteTargets: targets,
      visibleTargets: targets,
      repoMap
    })
    useDeleteWorktreeAtRiskLocalFiles({ isOpen: true, deleteTargets: targets, repoMap })
  })
}

beforeEach(() => {
  vi.mocked(getRuntimeGitStatus).mockClear()
  vi.mocked(getRuntimeWorktreeAtRiskLocalFiles).mockClear()
})
afterEach(() => seedCloudWorkspaceSnapshot({}))

describe('delete dialog host reads', () => {
  it('an asleep cloud workspace: no sandbox RPC at all', () => {
    seedCloud('wt-cloud', 'sleeping')
    openDialogReads(target('wt-cloud'))
    expect(getRuntimeGitStatus).not.toHaveBeenCalled()
    expect(getRuntimeWorktreeAtRiskLocalFiles).not.toHaveBeenCalled()
  })

  it('an awake cloud workspace: git status for "N uncommitted changes", never the file scan', () => {
    seedCloud('wt-cloud', 'ready')
    openDialogReads(target('wt-cloud'))
    expect(getRuntimeGitStatus).toHaveBeenCalledOnce()
    expect(getRuntimeWorktreeAtRiskLocalFiles).not.toHaveBeenCalled()
  })

  it('any other workspace: both reads, as upstream intends', () => {
    seedCloudWorkspaceSnapshot({ ids: new Set(), idsLoaded: true })
    openDialogReads(target('wt-local'))
    expect(getRuntimeGitStatus).toHaveBeenCalledOnce()
    expect(getRuntimeWorktreeAtRiskLocalFiles).toHaveBeenCalledOnce()
  })

  it('the guard itself', () => {
    seedCloud('wt-cloud', 'sleeping')
    expect(mayContactDeleteTargetHost({ id: 'wt-cloud' }, 'git-status')).toBe(false)
    expect(mayContactDeleteTargetHost({ id: 'wt-cloud' }, 'at-risk-scan')).toBe(false)
    expect(mayContactDeleteTargetHost({ id: 'wt-other' }, 'at-risk-scan')).toBe(true)
  })
})
