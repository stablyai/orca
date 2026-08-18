import { readFile } from 'node:fs/promises'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { FolderWorkspace } from '../../../shared/folder-workspace-types'
import type { ProjectGroup } from '../../../shared/project-group-types'
import type { FolderWorkspacePathStatusReason } from '../../../shared/folder-workspace-path-status'
import { folderWorkspaceKey } from '../../../shared/workspace-scope'
import { resolveWindowShortcutAction } from '../../../shared/window-shortcut-policy'

// Why: drives the real activation module against a real store, so a regression in
// the workspace dispatch or in the path-status guard itself both surface here.
// Mocking the module under test would let the gate be bypassed while still passing.
// Only the store singleton, the toast sink and the path-status IPC are substituted.

const mocks = vi.hoisted(() => ({
  toastError: vi.fn(),
  getPathStatus: vi.fn()
}))

vi.mock('sonner', () => ({ toast: { error: mocks.toastError, success: vi.fn() } }))

const { createTestStore } = await import('@/store/slices/store-test-helpers')
const store = createTestStore()

vi.mock('@/store', () => ({ useAppStore: store }))

const { activateAndRevealWorkspace } = await import('./worktree-activation')

const projectGroup: ProjectGroup = {
  id: 'group-1',
  name: 'Platform',
  parentPath: null,
  parentGroupId: null,
  createdFrom: 'manual',
  tabOrder: 0,
  isCollapsed: false,
  color: null,
  createdAt: 1,
  updatedAt: 1
}

const folderWorkspace: FolderWorkspace = {
  id: 'folder-workspace-1',
  projectGroupId: projectGroup.id,
  name: 'Unmounted folder',
  folderPath: '/mnt/detached/project',
  linkedTask: null,
  comment: '',
  isArchived: false,
  isUnread: false,
  isPinned: false,
  sortOrder: 1,
  lastActivityAt: 0,
  createdAt: 1,
  updatedAt: 1
}

async function seedFolderWorkspace(
  status: { exists: true } | { exists: false; reason: FolderWorkspacePathStatusReason }
): Promise<void> {
  store.setState({
    projectGroups: [projectGroup],
    folderWorkspaces: [folderWorkspace],
    activeWorktreeId: null,
    activeWorkspaceKey: null,
    activeView: 'terminal',
    folderWorkspacePathStatuses: {}
  })
  mocks.getPathStatus.mockResolvedValue({ path: folderWorkspace.folderPath, ...status })
  // Why the real fetch: it writes the cache under the exact key + request snapshot
  // that the activation guard reads back, so the fixture can't drift from production.
  await store
    .getState()
    .fetchFolderWorkspacePathStatus(
      { scope: 'folder-workspace', folderWorkspaceId: folderWorkspace.id },
      { force: true }
    )
}

describe('Cmd/Ctrl+1-9 folder-workspace path gate (#10716)', () => {
  beforeEach(() => {
    mocks.toastError.mockClear()
    vi.stubGlobal('window', {
      api: { folderWorkspaces: { getPathStatus: mocks.getPathStatus } }
    })
  })

  it('blocks the number shortcut when the folder path is missing', async () => {
    await seedFolderWorkspace({ exists: false, reason: 'missing' })

    activateAndRevealWorkspace(folderWorkspaceKey(folderWorkspace.id))

    expect(store.getState().activeWorkspaceKey).toBeNull()
    expect(store.getState().activeWorktreeId).toBeNull()
    expect(mocks.toastError).toHaveBeenCalledTimes(1)
  })

  it('blocks the number shortcut when the SSH connection owning the folder is ambiguous', async () => {
    await seedFolderWorkspace({ exists: false, reason: 'ambiguous-connection' })

    activateAndRevealWorkspace(folderWorkspaceKey(folderWorkspace.id))

    expect(store.getState().activeWorkspaceKey).toBeNull()
    expect(mocks.toastError).toHaveBeenCalledTimes(1)
  })

  it('still activates the number shortcut when the folder path is present', async () => {
    await seedFolderWorkspace({ exists: true })

    activateAndRevealWorkspace(folderWorkspaceKey(folderWorkspace.id))

    expect(store.getState().activeWorkspaceKey).toBe(folderWorkspaceKey(folderWorkspace.id))
    expect(mocks.toastError).not.toHaveBeenCalled()
  })

  // Why per AGENTS.md: the gate must hold on Windows/Linux Ctrl too, not just Cmd.
  // The digit chord resolves to the same jumpToWorktreeIndex action on every platform,
  // so all three land on the guarded activator this suite pins above.
  it.each([
    ['darwin' as const, { key: '1', code: 'Digit1', metaKey: true }],
    ['win32' as const, { key: '1', code: 'Digit1', ctrlKey: true }],
    ['linux' as const, { key: '1', code: 'Digit1', ctrlKey: true }]
  ])('routes the %s number chord to jumpToWorktreeIndex', (platform, input) => {
    expect(resolveWindowShortcutAction(input, platform)).toEqual({
      type: 'jumpToWorktreeIndex',
      index: 0
    })
  })

  it('does not fire the macOS chord on Windows/Linux, so Ctrl is the only path there', () => {
    expect(
      resolveWindowShortcutAction({ key: '1', code: 'Digit1', metaKey: true }, 'win32')
    ).not.toEqual({ type: 'jumpToWorktreeIndex', index: 0 })
  })

  // Why: the guard only helps if the IPC handler actually calls it. Pin the source
  // so re-pointing the handler back at the unguarded activateAndRevealWorktree fails.
  it('wires onJumpToWorktreeIndex to the guarded workspace activator', async () => {
    const source = await readFile(new URL('../hooks/useIpcEvents.ts', import.meta.url), 'utf8')
    const handler = source.slice(
      source.indexOf('onJumpToWorktreeIndex('),
      source.indexOf('onJumpToTabIndex(')
    )
    expect(handler).toContain('activateAndRevealWorkspace(target.id')
    expect(handler).not.toContain('activateAndRevealWorktree(target.id')
  })
})
