import { defineFixture } from '../../../../component-fixtures/component-fixture'
import type { Repo } from '../../../../../../shared/repo-types'
import type { Worktree } from '../../../../../../shared/worktree/types'
import { NativeChatComposerWorkspace } from './NativeChatComposerWorkspace'

function workspaceFixture({
  branch = 'master',
  width = 640,
  hostId = 'local',
  folder = false
}: {
  branch?: string
  width?: number
  hostId?: 'local' | `runtime:${string}` | `ssh:${string}`
  folder?: boolean
} = {}) {
  const repo: Repo = {
    id: 'composer-preview',
    path: '/preview/orca',
    displayName: 'orca',
    badgeColor: '',
    addedAt: 1,
    kind: folder ? 'folder' : 'git',
    executionHostId: hostId
  }
  const workspace: Worktree = {
    id: `${repo.id}::${repo.path}`,
    repoId: repo.id,
    hostId,
    instanceId: 'composer-preview-instance',
    path: repo.path,
    displayName: folder ? 'notes' : 'orca',
    branch: folder ? '' : branch,
    head: folder ? '' : 'a1b2c3d4e5f6',
    isBare: false,
    isMainWorktree: true,
    comment: '',
    linkedIssue: null,
    linkedPR: null,
    linkedLinearIssue: null,
    isArchived: false,
    isUnread: false,
    isPinned: false,
    sortOrder: 0,
    lastActivityAt: 1
  }
  return defineFixture({
    width,
    store: {
      repos: [repo],
      worktreesByRepo: { [repo.id]: [workspace] },
      unifiedTabsByWorktree: {
        [workspace.id]: [
          {
            id: 'composer-preview-tab',
            entityId: 'composer-preview-session',
            contentType: 'agent-session',
            agentSessionAgent: 'codex',
            worktreeId: workspace.id,
            groupId: 'preview',
            executionHostId: hostId,
            label: 'Chat',
            customLabel: null,
            color: null,
            sortOrder: 0,
            createdAt: 1
          }
        ]
      }
    },
    render: () => (
      <div className="native-chat-appearance bg-background py-3">
        <NativeChatComposerWorkspace terminalTabId="composer-preview-tab" />
      </div>
    ),
    interact: (frame) => {
      const button =
        frame.querySelector<HTMLButtonElement>('[aria-label^="Switch branch:"]') ??
        Array.from(frame.querySelectorAll<HTMLButtonElement>('button')).at(-1)
      if (button && !folder) {
        const label = button.querySelector('span')
        const row = button.parentElement
        if (
          !label ||
          !row ||
          button.getBoundingClientRect().right > row.getBoundingClientRect().right + 1
        ) {
          throw new Error('The branch control must fit inside the composer footer')
        }
        if (
          branch === 'master' &&
          button.getBoundingClientRect().right - label.getBoundingClientRect().right > 16
        ) {
          throw new Error('The branch hover target must end beside its short label')
        }
        if (width === 260 && label.scrollWidth <= label.clientWidth) {
          throw new Error('A long branch name must truncate in a narrow composer')
        }
        // Freeze the primitive's hover colours for a deterministic hover preview.
        button.style.backgroundColor = frame.closest('.dark')
          ? 'color-mix(in srgb, var(--accent) 50%, transparent)'
          : 'var(--accent)'
        button.style.color = 'var(--accent-foreground)'
      }
    }
  })
}

export const shortBranch = workspaceFixture()
export const longBranch = workspaceFixture({
  branch: 'feature/keep-the-composer-branch-button-within-a-narrow-pane'
})
export const narrowBranch = workspaceFixture({
  branch: 'feature/keep-the-composer-branch-button-within-a-narrow-pane',
  width: 260
})
export const remoteBranch = workspaceFixture({ hostId: 'runtime:preview-server' })
export const sshBranch = workspaceFixture({ hostId: 'ssh:preview-server' })
export const detachedCommit = workspaceFixture({ branch: '' })
export const folderWorkspace = workspaceFixture({ folder: true, width: 320 })
