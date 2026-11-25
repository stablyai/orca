import { expect, it, vi } from 'vitest'
import { useAppStore } from '@/store'
import { makeWorktree } from '@/components/sidebar/worktree-list/listing/worktree-list-lineage-card-test-fixtures'
import { reopenDoneWorkspaceOnChatSend } from './native-chat-send-reopens-done-workspace'

function seedWorkspace(workspaceStatus: string) {
  const updateWorktreeMeta = vi.fn(async () => ({ ok: true as const }))
  const worktree = {
    ...makeWorktree({
      id: 'wt-1',
      displayName: 'one',
      branch: 'one',
      sortOrder: 1,
      instanceId: 'i1'
    }),
    workspaceStatus
  }
  useAppStore.setState({
    worktreesByRepo: { 'repo-1': [worktree] },
    getKnownWorktreeById: (id: string) => (id === 'wt-1' ? worktree : undefined),
    updateWorktreeMeta
  })
  return updateWorktreeMeta
}

it('moves a Done workspace back to In progress when a message is sent in its chat', () => {
  const updateWorktreeMeta = seedWorkspace('completed')

  reopenDoneWorkspaceOnChatSend({ worktreeId: 'wt-1' })

  expect(updateWorktreeMeta).toHaveBeenCalledWith(
    'wt-1',
    { workspaceStatus: 'in-progress' },
    { executionHostId: 'local' }
  )
})

it('leaves a workspace that is not Done alone', () => {
  const updateWorktreeMeta = seedWorkspace('in-review')

  reopenDoneWorkspaceOnChatSend({ worktreeId: 'wt-1' })

  expect(updateWorktreeMeta).not.toHaveBeenCalled()
})
