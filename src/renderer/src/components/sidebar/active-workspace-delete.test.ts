// @vitest-environment happy-dom
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { AppState } from '@/store/types'
import type { Worktree } from '../../../../shared/worktree/types'
import {
  deleteWorkspaceTarget,
  requestActiveWorkspaceDelete,
  resolveActiveWorkspaceDeleteTarget
} from './active-workspace-delete'
import {
  cancelWorkspaceDeleteConfirmation,
  getArmedWorkspaceDeleteIdentity
} from './workspace-delete-confirmation'

vi.mock('@/lib/scroll-to-current-workspace-status', () => ({
  requestScrollToCurrentWorkspaceReveal: vi.fn()
}))

function worktree(overrides: Partial<Worktree> = {}): Worktree {
  // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: test fixture; the resolver reads only these fields.
  return {
    id: 'repo::/feature',
    repoId: 'repo',
    path: '/feature',
    branch: 'feature',
    isMainWorktree: false,
    ...overrides
  } as Worktree
}

type TestState = AppState

function state(worktrees: Worktree[] = [], overrides: Partial<TestState> = {}): TestState {
  // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: test fixture for the Pick the resolver consumes.
  return {
    activeModal: 'none',
    activeView: 'terminal',
    activeWorkspaceExecutionHostId: worktrees[0]?.hostId ?? null,
    activeWorktreeId: worktrees[0]?.id ?? null,
    deleteFolderWorkspace: vi.fn(),
    deleteStateByWorktreeId: {},
    detectedWorktreesByRepo: {},
    floatingWorkspacePath: null,
    folderWorkspaces: [],
    setActiveWorktree: vi.fn(),
    setSidebarOpen: vi.fn(),
    worktreesByRepo: { repo: worktrees },
    ...overrides
  } as unknown as TestState
}

const noFocus = { activeElement: null }
const confirmationDependencies = { timeoutMs: 4000, watchActiveWorkspace: () => () => {} }

afterEach(() => {
  cancelWorkspaceDeleteConfirmation()
  document.body.innerHTML = ''
})

function showConfirmNotice(): HTMLElement {
  const notice = document.createElement('div')
  notice.setAttribute('data-workspace-delete-confirm', '')
  document.body.append(notice)
  return notice
}

describe('resolveActiveWorkspaceDeleteTarget', () => {
  it('targets the active worktree on its exact host, not another at the same path', () => {
    const local = worktree({ hostId: 'local', instanceId: 'i-1' })
    const remote = worktree({ hostId: 'ssh:build', instanceId: 'i-2' })
    const current = state([local, remote], { activeWorkspaceExecutionHostId: 'ssh:build' })
    expect(resolveActiveWorkspaceDeleteTarget(current, noFocus)).toEqual({
      kind: 'worktree',
      worktree: remote,
      identity: 'ssh:build|repo::/feature'
    })
  })

  it('targets the active folder workspace with the host its sidebar card uses', () => {
    const current = state([], {
      activeWorktreeId: 'folder:folder-1',
      activeWorkspaceExecutionHostId: 'runtime:remote-1',
      folderWorkspaces: [
        {
          id: 'folder-1',
          name: 'Notes',
          folderPath: '/notes',
          projectGroupId: 'group-1',
          executionHostId: 'runtime:remote-1',
          linkedTask: null,
          comment: '',
          isArchived: false,
          isUnread: false,
          isPinned: false,
          sortOrder: 0,
          lastActivityAt: 0,
          createdAt: 0,
          updatedAt: 0
        }
      ]
    })
    expect(resolveActiveWorkspaceDeleteTarget(current, noFocus)).toEqual({
      kind: 'folder',
      executionHostId: 'runtime:remote-1',
      folderWorkspaceId: 'folder-1',
      workspaceKey: 'folder:folder-1',
      identity: 'runtime:remote-1|folder:folder-1'
    })
  })

  it('rejects no active workspace, the main worktree, an open modal, and non-terminal views', () => {
    expect(resolveActiveWorkspaceDeleteTarget(state([]), noFocus)).toBeNull()
    expect(
      resolveActiveWorkspaceDeleteTarget(
        state([worktree({ hostId: 'local', isMainWorktree: true })]),
        noFocus
      )
    ).toBeNull()
    const target = worktree({ hostId: 'local' })
    expect(
      resolveActiveWorkspaceDeleteTarget(
        state([target], { activeModal: 'delete-worktree' }),
        noFocus
      )
    ).toBeNull()
    expect(
      resolveActiveWorkspaceDeleteTarget(state([target], { activeView: 'settings' }), noFocus)
    ).toBeNull()
  })

  it('rejects a worktree that is already deleting', () => {
    const target = worktree({ hostId: 'ssh:build' })
    const current = state([target], {
      deleteStateByWorktreeId: {
        'ssh:build|repo::/feature': {
          isDeleting: true,
          error: null,
          canForceDelete: false,
          forceDeleteReason: null
        }
      }
    })
    expect(resolveActiveWorkspaceDeleteTarget(current, noFocus)).toBeNull()
  })

  it('rejects while an editable control has focus', () => {
    const input = document.createElement('input')
    document.body.append(input)
    input.focus()
    try {
      expect(
        resolveActiveWorkspaceDeleteTarget(state([worktree({ hostId: 'local' })]), document)
      ).toBeNull()
    } finally {
      input.remove()
    }
  })
})

describe('requestActiveWorkspaceDelete', () => {
  it('arms on the first press and deletes on the second, confirmed and unforced', () => {
    const target = worktree({ hostId: 'ssh:build', instanceId: 'i-2' })
    const current = state([target])
    const deleteWorktree = vi.fn()
    const dependencies = {
      deleteWorktree,
      getCurrentState: () => current,
      confirmationDependencies
    }

    expect(requestActiveWorkspaceDelete(current, undefined, dependencies)).toBe(true)
    expect(deleteWorktree).not.toHaveBeenCalled()
    expect(current.setSidebarOpen).toHaveBeenCalledWith(true)
    expect(getArmedWorkspaceDeleteIdentity()).toBe('ssh:build|repo::/feature')

    showConfirmNotice()
    expect(requestActiveWorkspaceDelete(current, undefined, dependencies)).toBe(true)
    expect(getArmedWorkspaceDeleteIdentity()).toBeNull()
    expect(deleteWorktree).toHaveBeenCalledWith(target.id, {
      confirmed: true,
      expectedHostId: 'ssh:build',
      expectedInstanceId: 'i-2'
    })
  })

  it('does not delete on the second press when the prompt was never on screen', () => {
    const current = state([worktree({ hostId: 'local' })])
    const deleteWorktree = vi.fn()
    const dependencies = {
      deleteWorktree,
      getCurrentState: () => current,
      confirmationDependencies
    }

    requestActiveWorkspaceDelete(current, undefined, dependencies)
    requestActiveWorkspaceDelete(current, undefined, dependencies)
    const hidden = document.createElement('div')
    hidden.setAttribute('aria-hidden', 'true')
    hidden.append(showConfirmNotice())
    document.body.append(hidden)
    requestActiveWorkspaceDelete(current, undefined, dependencies)
    expect(deleteWorktree).not.toHaveBeenCalled()
    expect(getArmedWorkspaceDeleteIdentity()).toBe('local|repo::/feature')
  })

  it('re-arms the new target instead of deleting when the active workspace changed', () => {
    const one = worktree({ id: 'repo::/one', path: '/one', hostId: 'local' })
    const two = worktree({ id: 'repo::/two', path: '/two', hostId: 'local' })
    const deleteWorktree = vi.fn()
    const dependencies = {
      deleteWorktree,
      getCurrentState: () => state([one]),
      confirmationDependencies
    }

    requestActiveWorkspaceDelete(state([one, two]), undefined, dependencies)
    requestActiveWorkspaceDelete(state([two, one]), undefined, dependencies)
    expect(deleteWorktree).not.toHaveBeenCalled()
    expect(getArmedWorkspaceDeleteIdentity()).toBe('local|repo::/two')
  })

  it('does nothing without a target', () => {
    expect(requestActiveWorkspaceDelete(state([]))).toBe(false)
    expect(getArmedWorkspaceDeleteIdentity()).toBeNull()
  })
})

describe('deleteWorkspaceTarget', () => {
  const folder = {
    kind: 'folder' as const,
    executionHostId: 'runtime:remote-1' as const,
    folderWorkspaceId: 'folder-1',
    workspaceKey: 'folder:folder-1',
    identity: 'runtime:remote-1|folder:folder-1'
  }

  it('removes a folder workspace from Orca and clears it as active', async () => {
    const current = state([], {
      activeWorktreeId: 'folder:folder-1',
      activeWorkspaceExecutionHostId: 'runtime:remote-1',
      deleteFolderWorkspace: vi.fn().mockResolvedValue(true)
    })
    expect(
      deleteWorkspaceTarget(folder, {
        deleteWorktree: vi.fn(),
        getCurrentState: () => current
      })
    ).toBe(true)
    await vi.waitFor(() => expect(current.setActiveWorktree).toHaveBeenCalledWith(null))
    expect(current.deleteFolderWorkspace).toHaveBeenCalledWith('folder-1', {
      executionHostId: 'runtime:remote-1'
    })
  })

  it('rejects a duplicate folder delete while the first is pending', async () => {
    let finishDelete!: (deleted: boolean) => void
    const current = state([], {
      deleteFolderWorkspace: vi.fn(
        () => new Promise<boolean>((resolve) => (finishDelete = resolve))
      )
    })
    const dependencies = { deleteWorktree: vi.fn(), getCurrentState: () => current }
    expect(deleteWorkspaceTarget(folder, dependencies)).toBe(true)
    expect(deleteWorkspaceTarget(folder, dependencies)).toBe(false)
    finishDelete(false)
    await vi.waitFor(() => expect(deleteWorkspaceTarget(folder, dependencies)).toBe(true))
    finishDelete(false)
  })
})

const { rejectAppStoreAccess } = vi.hoisted(() => ({
  rejectAppStoreAccess: vi.fn(() => {
    throw new Error('Pure helper tests must not access the app store')
  })
}))

vi.mock('@/store', () => ({
  useAppStore: Object.assign(rejectAppStoreAccess, {
    getState: rejectAppStoreAccess,
    getInitialState: rejectAppStoreAccess,
    setState: rejectAppStoreAccess,
    subscribe: rejectAppStoreAccess
  })
}))

afterEach(() => {
  expect(rejectAppStoreAccess).not.toHaveBeenCalled()
})
