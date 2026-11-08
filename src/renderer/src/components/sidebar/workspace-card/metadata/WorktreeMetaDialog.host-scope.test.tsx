// @vitest-environment happy-dom
import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { useAppStore } from '@/store'
import type { Repo } from '../../../../../../shared/repo-types'
import type { Worktree, WorkspaceAttachment } from '../../../../../../shared/worktree/types'

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

  it('does not fall back to another host when the requested workspace disappeared', () => {
    open('ssh:missing', [workspace()])
    expect(screen.getByTestId('owner-repo').textContent).toBe('none')
    expect(screen.queryByText('Local task')).toBeNull()
    const save = screen.getByRole('button', { name: 'Save' })
    expect(save.hasAttribute('disabled')).toBe(true)
    fireEvent.click(save)
    expect(update).not.toHaveBeenCalled()
  })
})
