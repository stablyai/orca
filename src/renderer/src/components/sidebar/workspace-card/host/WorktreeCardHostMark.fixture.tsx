import { getDefaultSettings } from '../../../../../../shared/constants'
import type { HostedWorkspaceStatus } from '../../../../../../shared/hosted-sandbox/hosted-sandbox-wire'
import type { Repo } from '../../../../../../shared/repo-types'
import type { Worktree } from '../../../../../../shared/worktree/types'
import { defineFixture } from '../../../../component-fixtures/component-fixture'
import { seedCloudWorkspaceSnapshot } from '@/lib/orca-cloud/orca-cloud-workspace-store'
import { makeRepo, makeWorktree } from '../../../worktree-jump/worktree-jump-palette-test-fixtures'
import WorktreeCard from '../surface/WorktreeCard'

const local: Repo = { ...makeRepo(), displayName: 'orca' }
const ssh: Repo = { ...makeRepo(), id: 'repo-ssh', displayName: 'api', connectionId: 'devbox' }

const status = (state: HostedWorkspaceStatus['state']): HostedWorkspaceStatus => ({
  state,
  metrics: null,
  uptimeMs: null,
  usage: { totalMs: 3_600_000, centsPerHour: 100, costCents: 100 },
  archive: null,
  checkedAt: Date.now()
})

const cloud: Record<string, HostedWorkspaceStatus> = {
  'cloud-running': status('ready'),
  'cloud-asleep': status('sleeping'),
  'cloud-waking': status('waking'),
  'cloud-unresponsive': status('unresponsive'),
  'cloud-failed': status('failed')
}

const row = (id: string, name: string, repo: Repo = local): Worktree =>
  makeWorktree(id, name, { repoId: repo.id, branch: `refs/heads/${id}` })

const localRows = [row('local-a', 'Tidy settings copy'), row('local-b', 'Fix flaky e2e test')]
const sshRows = [row('ssh-a', 'Profile slow query', ssh)]
const cloudRows = [
  row('cloud-running', 'Fix auth redirect'),
  row('cloud-asleep', 'Support excalidraw files'),
  row('cloud-waking', 'Bump Electron'),
  row('cloud-unresponsive', 'Index rebuild'),
  // No branch yet (it never started): line 2 is the state word alone, no dangling separator.
  { ...row('cloud-failed', 'Migrate billing'), branch: '', head: '' }
]
const vmRows = [row('vm-suspended', 'Benchmark recipe VM')]

function setup(): void {
  seedCloudWorkspaceSnapshot({
    ids: new Set(Object.keys(cloud)),
    idsLoaded: true,
    status: Object.fromEntries(
      Object.entries(cloud).map(([id, value]) => [
        id,
        { status: value, loading: false, error: null, fetchedAt: Date.now() }
      ])
    )
  })
  window.api.orcaCloudWorkspace = {
    ...window.api.orcaCloudWorkspace,
    getStatus: async ({ workspaceId }: { workspaceId: string }) => ({
      ok: true as const,
      value: cloud[workspaceId] ?? status('ready')
    })
  }
}

function Rows({ rows }: { rows: { worktree: Worktree; repo: Repo }[] }): React.JSX.Element {
  return (
    <div className="flex flex-col gap-1 bg-worktree-sidebar p-2 text-worktree-sidebar-foreground">
      {rows.map(({ worktree, repo }) => (
        <WorktreeCard
          key={worktree.id}
          worktree={worktree}
          repo={repo}
          isActive={false}
          nativeDragEnabled={false}
        />
      ))}
    </div>
  )
}

const vmRuntime = {
  id: 'runtime-vm',
  workspaceId: 'vm-suspended',
  status: 'suspended' as const,
  runtimeEnvironmentId: 'env-vm',
  canSuspend: true
}

/**
 * The cloud icon rule on real cards: one 12px host slot (Monitor, Server, Box, Cloud), state as a
 * badge and named on line 2; the status lane shows agents only. A cloud row also registered as a
 * VM runtime (as at runtime) must not get the VM badge.
 */
export const mixedSidebar = defineFixture({
  width: 320,
  store: {
    settings: getDefaultSettings('/home/fixture'),
    repos: [local, ssh],
    worktreesByRepo: {
      [local.id]: [...localRows, ...cloudRows, ...vmRows],
      [ssh.id]: sshRows
    },
    worktreeCardProperties: ['status', 'branch'],
    ephemeralVmRuntimesByWorkspaceId: {
      'vm-suspended': vmRuntime,
      'cloud-asleep': { ...vmRuntime, id: 'runtime-cloud', workspaceId: 'cloud-asleep' }
    }
  },
  setup,
  render: () => (
    <Rows
      rows={[
        ...localRows.map((worktree) => ({ worktree, repo: local })),
        ...sshRows.map((worktree) => ({ worktree, repo: ssh })),
        ...cloudRows.map((worktree) => ({ worktree, repo: local })),
        ...vmRows.map((worktree) => ({ worktree, repo: local }))
      ]}
    />
  )
})

/** Local only: no host slot at all, so nothing changes for people who never leave this computer. */
export const localOnly = defineFixture({
  width: 320,
  store: {
    settings: getDefaultSettings('/home/fixture'),
    repos: [local],
    worktreesByRepo: { [local.id]: localRows },
    worktreeCardProperties: ['status', 'branch']
  },
  setup: () => seedCloudWorkspaceSnapshot({ ids: new Set(), idsLoaded: true }),
  render: () => <Rows rows={localRows.map((worktree) => ({ worktree, repo: local }))} />
})
