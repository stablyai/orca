// CLOUD-ROW-DUP-TAG: an Orca Cloud row (owned or paired) shows its cloud mark and no "Orca Cloud"
// host pill on line 2; an SSH row keeps its host pill. Line 2 keeps the branch and the state word.
import { getDefaultSettings } from '../../../../../../shared/constants'
import type { PublicKnownRuntimeEnvironment } from '../../../../../../shared/remote-runtime/host-catalog/runtime-environments'
import type { HostedWorkspaceStatus } from '../../../../../../shared/hosted-sandbox/hosted-sandbox-wire'
import { defineFixture } from '../../../../component-fixtures/component-fixture'
import { seedCloudWorkspaceSnapshot } from '@/lib/orca-cloud/orca-cloud-workspace-store'
import { makeRepo, makeWorktree } from '../../../worktree-jump/worktree-jump-palette-test-fixtures'
import WorktreeCard from './WorktreeCard'

// Cloud projects live on their sandbox's server, as in the app (the repo's execution host).
const cloudRepo = {
  ...makeRepo(),
  id: 'repo-cloud',
  displayName: 'Hello-World',
  executionHostId: 'runtime:env-owned-1' as const
}
const asleepRepo = {
  ...makeRepo(),
  id: 'repo-cloud-2',
  displayName: 'Hello-World',
  executionHostId: 'runtime:env-owned-2' as const
}
const pairedRepo = {
  ...makeRepo(),
  id: 'repo-paired',
  displayName: 'orca-sandbox-push-test',
  executionHostId: 'runtime:env-paired' as const
}
const sshRepo = { ...makeRepo(), id: 'repo-ssh', displayName: 'api', connectionId: 'devbox' }

const sleeping: HostedWorkspaceStatus = {
  state: 'sleeping',
  metrics: null,
  uptimeMs: null,
  usage: { totalMs: 0, centsPerHour: 100, costCents: 0 },
  archive: null,
  checkedAt: 1
}
const ready: HostedWorkspaceStatus = { ...sleeping, state: 'ready' }

const ownedRunning = makeWorktree('cloud-running', 'codex sandbox2', {
  repoId: cloudRepo.id,
  branch: 'refs/heads/codex-sandbox2',
  hostId: 'runtime:env-owned-1'
})
const ownedAsleep = makeWorktree('cloud-asleep', 'fix login', {
  repoId: asleepRepo.id,
  branch: 'refs/heads/fix-login',
  hostId: 'runtime:env-owned-2'
})
const paired = makeWorktree('paired-main', 'orca-sandbox-push-test', {
  repoId: pairedRepo.id,
  branch: 'refs/heads/master',
  hostId: 'runtime:env-paired',
  isMainWorktree: true
})
const ssh = makeWorktree('ssh-row', 'rate limits', {
  repoId: sshRepo.id,
  branch: 'refs/heads/rate-limits'
})

/** A catalog row with only the fields the cloud checks read (a server's name, a paired mark). */
function catalogEntry(entry: {
  id: string
  name: string
  source?: 'ephemeral-vm'
  orcaCloudPaired?: true
}): PublicKnownRuntimeEnvironment {
  // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: fixture catalog rows; the row checks read only these fields.
  return entry as unknown as PublicKnownRuntimeEnvironment
}

const environments = [
  catalogEntry({ id: 'env-owned-1', name: 'Hello-World sandbox a1b2c3d4', source: 'ephemeral-vm' }),
  catalogEntry({ id: 'env-owned-2', name: 'Hello-World sandbox e5f6a7b8', source: 'ephemeral-vm' }),
  catalogEntry({ id: 'env-paired', name: 'orca-sandbox-push-test (cloud)', orcaCloudPaired: true })
]

const rows = [
  { worktree: ownedRunning, repo: cloudRepo, label: 'Orca Cloud' },
  { worktree: ownedAsleep, repo: asleepRepo, label: 'Orca Cloud' },
  { worktree: paired, repo: pairedRepo, label: 'Orca Cloud' },
  { worktree: ssh, repo: sshRepo, label: 'devbox' }
]

/** Owned running, owned asleep ("Asleep ·"), paired, then SSH (which keeps its pill). */
export const cloudAndSshRows = defineFixture({
  width: 320,
  store: {
    settings: getDefaultSettings('/home/fixture'),
    repos: [cloudRepo, asleepRepo, pairedRepo, sshRepo],
    worktreesByRepo: {
      [cloudRepo.id]: [ownedRunning],
      [asleepRepo.id]: [ownedAsleep],
      [pairedRepo.id]: [paired],
      [sshRepo.id]: [ssh]
    },
    worktreeCardProperties: ['status', 'branch', 'host'],
    runtimeEnvironments: environments
  },
  setup: () => {
    seedCloudWorkspaceSnapshot({
      ids: new Set([ownedRunning.id, ownedAsleep.id]),
      paired: { [paired.id]: 'env-paired' },
      idsLoaded: true,
      status: {
        [paired.id]: { status: ready, loading: false, error: null, fetchedAt: Date.now() },
        [ownedRunning.id]: { status: ready, loading: false, error: null, fetchedAt: Date.now() },
        [ownedAsleep.id]: { status: sleeping, loading: false, error: null, fetchedAt: Date.now() }
      }
    })
    window.api.orcaCloudWorkspace = {
      ...window.api.orcaCloudWorkspace,
      listCloudWorkspaceIds: async () => [ownedRunning.id, ownedAsleep.id],
      getStatus: async ({ workspaceId }: { workspaceId: string }) => ({
        ok: true as const,
        value: workspaceId === ownedAsleep.id ? sleeping : ready
      })
    }
  },
  render: () => {
    return (
      <div className="flex flex-col gap-1 bg-worktree-sidebar p-2 text-worktree-sidebar-foreground">
        {rows.map(({ worktree, repo, label }) => (
          <WorktreeCard
            key={worktree.id}
            worktree={worktree}
            repo={repo}
            isActive={false}
            nativeDragEnabled={false}
            hostContextLabel={label}
          />
        ))}
      </div>
    )
  }
})
