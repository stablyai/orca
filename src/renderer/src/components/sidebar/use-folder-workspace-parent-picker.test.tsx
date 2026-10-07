// @vitest-environment happy-dom
import { act, cleanup, renderHook, waitFor } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { useFolderWorkspaceParentPicker } from './use-folder-workspace-parent-picker'
import { captureFolderParentContext } from './folder-workspace-parent-candidates'
import { makeRepo, makeWorktree } from '../worktree-jump-palette-test-fixtures'
import { createWorktreeIdentity } from '../../../../shared/worktree/identity'
import type { FolderWorkspace } from '../../../../shared/folder-workspace-types'
import type { ProjectGroup } from '../../../../shared/project-group-types'
import { filterWorktreeParentCandidates } from './worktree-parent-picker-filtering'

const load = vi.hoisted(() => vi.fn())
const attach = vi.hoisted(() => vi.fn())
vi.mock('@/store', () => ({
  useAppStore: (selector: (state: unknown) => unknown) =>
    selector({ loadFolderParentCatalog: load, attachWorktreeToFolderWorkspace: attach })
}))
const child = makeWorktree('repo-1::/child', 'Child', {
  hostId: 'local',
  instanceId: 'child',
  identity: createWorktreeIdentity({
    worktreeId: 'repo-1::/child',
    executionHostId: 'local',
    instanceId: 'child'
  })
})
const context = captureFolderParentContext({ repos: [makeRepo()] }, child)
const group: ProjectGroup = {
  id: 'group',
  name: 'Payments',
  parentPath: '/repo',
  parentGroupId: null,
  createdFrom: 'manual',
  tabOrder: 0,
  isCollapsed: false,
  color: null,
  createdAt: 0,
  updatedAt: 0
}
const folder: FolderWorkspace = {
  id: 'folder',
  projectGroupId: group.id,
  name: 'Ticket',
  folderPath: '/repo/payments',
  linkedTask: null,
  comment: '',
  isArchived: false,
  isUnread: false,
  isPinned: false,
  sortOrder: 0,
  lastActivityAt: 0,
  createdAt: 0,
  updatedAt: 0,
  executionHostId: 'local'
}

beforeEach(() => {
  vi.clearAllMocks()
  load.mockResolvedValue({
    target: { kind: 'local' },
    projectGroups: [group],
    folderWorkspaces: [folder],
    repos: [],
    lineage: {}
  })
  attach.mockResolvedValue(undefined)
})
afterEach(cleanup)

describe('folder picker state', () => {
  it('loads the captured owner and selects its folder without using active workspace state', async () => {
    const close = vi.fn()
    const { result } = renderHook(() => useFolderWorkspaceParentPicker(context, true, close))
    await waitFor(() => expect(result.current.candidates).toHaveLength(1))
    expect(load).toHaveBeenCalledWith(context)
    await act(async () => result.current.select('folder:folder'))
    expect(attach).toHaveBeenCalledWith(context, folder.id)
    expect(close).toHaveBeenCalledOnce()
  })
  it('reports missing ownership without loading or mutating', async () => {
    const { result } = renderHook(() => useFolderWorkspaceParentPicker(null, true, vi.fn()))
    await waitFor(() => expect(result.current.error).toContain('ownership'))
    expect(load).not.toHaveBeenCalled()
    expect(attach).not.toHaveBeenCalled()
  })
  it('distinguishes an unavailable catalog from an empty candidate list', async () => {
    load.mockRejectedValue(new Error('Offline'))
    const { result } = renderHook(() => useFolderWorkspaceParentPicker(context, true, vi.fn()))
    await waitFor(() => expect(result.current.error).toContain('Could not load'))
    expect(result.current.loading).toBe(false)
  })
  it('does not resend when selecting the confirmed current parent', async () => {
    load.mockResolvedValue({
      target: { kind: 'local' },
      projectGroups: [group],
      folderWorkspaces: [folder],
      repos: [],
      lineage: {
        'worktree:repo-1::/child': {
          childWorkspaceKey: 'worktree:repo-1::/child',
          childInstanceId: 'child',
          parentWorkspaceKey: 'folder:folder',
          origin: 'manual',
          capture: { source: 'manual-action', confidence: 'explicit' },
          createdAt: 0
        }
      }
    })
    const close = vi.fn()
    const { result } = renderHook(() => useFolderWorkspaceParentPicker(context, true, close))
    await waitFor(() => expect(result.current.candidates).toHaveLength(1))
    await act(async () => result.current.select('folder:folder'))
    expect(attach).not.toHaveBeenCalled()
    expect(close).toHaveBeenCalledOnce()
  })
  it('searches displayed group and path fields through the existing scorer', async () => {
    const { result } = renderHook(() => useFolderWorkspaceParentPicker(context, true, vi.fn()))
    await waitFor(() => expect(result.current.candidates).toHaveLength(1))
    const value = (row: typeof child) => result.current.byId.get(row.id)?.searchText ?? ''
    expect(
      filterWorktreeParentCandidates(result.current.candidates, 'Payments', value)
    ).toHaveLength(1)
    expect(
      filterWorktreeParentCandidates(result.current.candidates, 'repo/payments', value)
    ).toHaveLength(1)
  })
})
