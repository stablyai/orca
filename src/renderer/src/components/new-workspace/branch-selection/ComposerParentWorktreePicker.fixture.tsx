import { defineFixture } from '../../../component-fixtures/component-fixture'
import type { Repo } from '../../../../../shared/repo-types'
import type { Worktree } from '../../../../../shared/worktree/types'
import { ComposerParentWorktreePicker } from './ComposerParentWorktreePicker'

function repo(id: string, displayName: string, executionHostId?: Repo['executionHostId']): Repo {
  return {
    id,
    path: `/src/${displayName}`,
    displayName,
    badgeColor: 'var(--muted-foreground)',
    addedAt: 0,
    ...(executionHostId ? { executionHostId } : {})
  }
}

function worktree(
  id: string,
  repoId: string,
  displayName: string,
  hostId: Worktree['hostId']
): Worktree {
  return {
    id,
    instanceId: `${id}-instance`,
    repoId,
    hostId,
    path: `/src/${displayName}`,
    branch: `refs/heads/${displayName}`,
    head: 'abc123',
    isBare: false,
    isMainWorktree: false,
    linkedIssue: null,
    linkedPR: null,
    linkedLinearIssue: null,
    isArchived: false,
    comment: '',
    isUnread: false,
    isPinned: false,
    displayName,
    sortOrder: 0,
    lastActivityAt: 0
  }
}

const local = repo('orca-local', 'orca')
const server = repo('orca-server', 'orca', 'runtime:build-box')

/** A new workspace on this Mac may nest under a workspace on a paired server. */
export const parentOnAnotherMachine = defineFixture({
  width: 320,
  store: {
    repos: [local, server],
    worktreesByRepo: {
      [local.id]: [worktree('orca-local::/src/fix-login', local.id, 'fix-login', 'local')],
      [server.id]: [
        worktree(
          'orca-server::/work/fix-login-tests',
          server.id,
          'fix-login-tests',
          'runtime:build-box'
        )
      ]
    }
  },
  render: () => (
    <ComposerParentWorktreePicker
      repoId={local.id}
      executionHostId="local"
      value={null}
      onChange={() => {}}
    />
  ),
  interact: async (frame) => {
    frame.querySelector<HTMLElement>('[role="combobox"]')?.click()
    await new Promise((resolve) => setTimeout(resolve, 200))
  }
})
