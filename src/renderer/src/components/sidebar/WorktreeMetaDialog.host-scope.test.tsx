// @vitest-environment happy-dom
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { useAppStore } from '@/store'
import type { Repo } from '../../../../shared/repo-types'
import type { Worktree, WorkspaceAttachment } from '../../../../shared/worktree/types'
import type { FolderWorkspace } from '../../../../shared/folder-workspace-types'
import { folderWorkspaceKey } from '../../../../shared/workspace-scope'
import WorktreeMetaDialog from './WorktreeMetaDialog'

vi.mock('./WorktreeDisplayNameField', () => ({ WorktreeDisplayNameField: () => null }))
vi.mock('./WorktreeLinkedItemsField', () => ({
  WorktreeLinkedItemsField: ({ items, repo }: { items: WorkspaceAttachment[]; repo?: Repo }) => (
    <div>
      <span data-testid="owner-repo">{repo?.path ?? 'none'}</span>
      {items.map((item) => (
        <span key={item.number}>{item.title}</span>
      ))}
    </div>
  )
}))

const initialState = useAppStore.getInitialState()
const update = vi.fn(async () => ({ ok: true as const }))
const localRepo: Repo = {
  id: 'repo',
  path: '/local',
  displayName: 'Local',
  badgeColor: '',
  addedAt: 1
}
const remoteRepo: Repo = { ...localRepo, path: '/remote', executionHostId: 'ssh:box' }
function workspace(hostId?: Worktree['hostId']): Worktree {
  return {
    id: 'shared-id',
    repoId: 'repo',
    path: '/workspace',
    branch: 'feature',
    head: 'abc',
    isBare: false,
    isMainWorktree: false,
    isArchived: false,
    isUnread: false,
    isPinned: false,
    sortOrder: 0,
    lastActivityAt: 1,
    displayName: 'Workspace',
    comment: 'note',
    hostId,
    linkedPR: null,
    linkedIssue: null,
    linkedLinearIssue: null,
    linkedItems: [
      {
        provider: 'github',
        type: 'issue',
        number: hostId ? 2 : 1,
        title: hostId ? 'Remote task' : 'Local task'
      }
    ]
  }
}
function open(
  executionHostId: string,
  rows: Worktree[] = [workspace(), workspace('ssh:box')],
  repos: Repo[] = [localRepo, remoteRepo]
): void {
  useAppStore.setState({
    repos,
    worktreesByRepo: { repo: rows },
    updateWorktreeMeta: update,
    activeModal: 'edit-meta',
    modalData: { worktreeId: 'shared-id', repoId: 'repo', executionHostId }
  })
  render(<WorktreeMetaDialog />)
}

describe('workspace details exact host selection', () => {
  beforeEach(() => {
    useAppStore.setState(initialState, true)
    update.mockClear()
  })
  afterEach(cleanup)

  it.each([
    ['local', '/local', 'Local task', 'Remote task'],
    ['ssh:box', '/remote', 'Remote task', 'Local task']
  ])(
    'seeds the %s workspace and repository with duplicate IDs',
    async (host, path, shown, hidden) => {
      open(host)
      expect(screen.getByTestId('owner-repo').textContent).toBe(path)
      expect(screen.getByText(shown)).toBeTruthy()
      expect(screen.queryByText(hidden)).toBeNull()
      fireEvent.click(screen.getByRole('button', { name: 'Save' }))
      await waitFor(() =>
        expect(update).toHaveBeenCalledWith('shared-id', {}, { executionHostId: host })
      )
    }
  )

  it('does not fall back to another host when the requested workspace disappeared', () => {
    open('ssh:missing', [workspace()])
    expect(screen.getByTestId('owner-repo').textContent).toBe('none')
    expect(screen.queryByText('Local task')).toBeNull()
    const save = screen.getByRole('button', { name: 'Save' })
    expect(save.hasAttribute('disabled')).toBe(true)
    fireEvent.click(save)
    expect(update).not.toHaveBeenCalled()
  })

  it('uses the owning runtime repository for its nested SSH worktree alias', () => {
    const row = { ...workspace('ssh:nested'), runtimeOwnerEnvironmentId: 'hub' }
    open('runtime:hub', [row], [{ ...localRepo, path: '/hub', executionHostId: 'runtime:hub' }])
    expect(screen.getByTestId('owner-repo').textContent).toBe('/hub')
    expect(screen.getByText('Remote task')).toBeTruthy()
  })

  it('selects the host-qualified folder when folder IDs are duplicated', () => {
    const folder: FolderWorkspace = {
      id: 'folder',
      projectGroupId: 'group',
      name: 'Docs',
      folderPath: '/docs',
      linkedTask: null,
      comment: '',
      isArchived: false,
      isUnread: false,
      isPinned: false,
      sortOrder: 0,
      lastActivityAt: 1,
      createdAt: 1,
      updatedAt: 1,
      linkedItems: [{ provider: 'github', type: 'issue', number: 1, title: 'Local folder task' }]
    }
    useAppStore.setState({
      folderWorkspaces: [
        folder,
        {
          ...folder,
          executionHostId: 'ssh:box',
          linkedItems: [
            { provider: 'github', type: 'issue', number: 2, title: 'Remote folder task' }
          ]
        }
      ],
      updateWorktreeMeta: update,
      activeModal: 'edit-meta',
      modalData: { worktreeId: folderWorkspaceKey('folder'), executionHostId: 'ssh:box' }
    })
    render(<WorktreeMetaDialog />)
    expect(screen.getByText('Remote folder task')).toBeTruthy()
    expect(screen.queryByText('Local folder task')).toBeNull()
  })
})
