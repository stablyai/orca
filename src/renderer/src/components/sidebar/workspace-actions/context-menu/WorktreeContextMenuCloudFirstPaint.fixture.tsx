// MENU-FIRST-PAINT (Neil): a cloud workspace's right-click menu is whole when it opens; nothing
// appears a second later. The answers this menu used to wait for take 900 ms here (a slow link):
// the cloud workspace list and the team's record. Running and asleep (one Sleep or Wake item).
import { defineFixture } from '../../../../component-fixtures/component-fixture'
import type { Repo } from '../../../../../../shared/repository/repo-types'
import type { Worktree } from '../../../../../../shared/worktree/types'
import type { HostedWorkspaceStatus } from '../../../../../../shared/hosted-sandbox/hosted-sandbox-wire'
import { seedCloudWorkspaceSnapshot } from '@/lib/orca-cloud/orca-cloud-workspace-store'
import WorktreeContextMenu from './WorktreeContextMenu'

const SLOW_MS = 900
const slow = <T,>(value: T): Promise<T> =>
  new Promise((resolve) => setTimeout(() => resolve(value), SLOW_MS))

const repo: Repo = {
  id: 'cloud-repo',
  path: '/workspace/hello-world',
  displayName: 'hello-world',
  badgeColor: '',
  addedAt: 1
}

function cloudWorktree(id: string, name: string): Worktree {
  return {
    id,
    repoId: repo.id,
    hostId: 'runtime:env-cloud',
    instanceId: `${id}-instance`,
    path: '/workspace/hello-world',
    displayName: name,
    branch: 'refs/heads/fix-login',
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
    lastActivityAt: 1
  }
}

const status = (state: 'ready' | 'sleeping'): HostedWorkspaceStatus => ({
  state,
  metrics: null,
  uptimeMs: null,
  usage: { totalMs: 0, centsPerHour: 100, costCents: 0 },
  archive: null,
  checkedAt: 1
})

function firstPaint(asleep: boolean) {
  const worktree = cloudWorktree(asleep ? 'cloud-asleep' : 'cloud-running', 'fix login')
  return defineFixture({
    width: 420,
    store: {
      repos: [repo],
      worktreesByRepo: { [repo.id]: [worktree] },
      // Team sharing on, so the Share row (which needs the team's record) is in the menu.
      orcaProfileAuthStatus: {
        activeProfileId: 'p',
        configured: true,
        state: 'connected',
        persistence: 'encrypted',
        cloud: { cloudProfileId: 'c', userId: 'u', email: 'e', activeOrgId: 'o', linkedAt: 0 },
        organizations: [{ orgId: 'o', name: 'Team', role: 'Owner' }],
        capabilities: { flags: { cloudTeamSharing: true }, refreshedAt: 0 }
      },
      ephemeralVmRuntimesByWorkspaceId: {
        [worktree.id]: {
          id: 'vm-1',
          workspaceId: worktree.id,
          status: asleep ? 'suspended' : 'running',
          runtimeEnvironmentId: 'env-cloud',
          canSuspend: true
        }
      },
      // Restored panels on the asleep one: what made the local "Sleep" show beside Wake.
      browserTabsByWorktree: asleep
        ? {
            [worktree.id]: [
              {
                id: 'browser-1',
                worktreeId: worktree.id,
                url: 'http://localhost:3000',
                title: 'App',
                loading: false,
                faviconUrl: null,
                canGoBack: false,
                canGoForward: false,
                loadError: null,
                createdAt: 1
              }
            ]
          }
        : {}
    },
    setup: () => {
      seedCloudWorkspaceSnapshot({
        ids: new Set([worktree.id]),
        idsLoaded: true,
        status: {
          [worktree.id]: {
            status: status(asleep ? 'sleeping' : 'ready'),
            loading: false,
            error: null,
            fetchedAt: Date.now()
          }
        }
      })
      Object.assign(window.api.orcaCloudWorkspace, {
        listCloudWorkspaceIds: () => slow([worktree.id]),
        prepareTransferToLocal: () => slow(null)
      })
      Object.assign(window.api.cloudWorkspaces, {
        localWorkspaces: () => slow([{ worktreeId: worktree.id, sandboxId: 'sbx_1' }]),
        environmentBindings: () => slow({}),
        get: () =>
          slow({
            ok: true,
            value: { id: 'sbx_1', status: 'running', visibility: 'private', access: 'owner' }
          })
      })
    },
    render: () => (
      <div className="h-[520px] bg-background p-4 text-foreground">
        <WorktreeContextMenu worktree={worktree}>
          <div className="text-sm" data-first-paint-row>
            fix login
          </div>
        </WorktreeContextMenu>
      </div>
    )
  })
}

export const running = firstPaint(false)
export const asleep = firstPaint(true)
