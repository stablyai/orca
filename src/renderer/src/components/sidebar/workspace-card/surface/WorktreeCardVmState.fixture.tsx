import { getDefaultSettings } from '../../../../../../shared/constants'
import type { EphemeralVmRuntimeStatus } from '../../../../../../shared/ephemeral-vm-runtimes'
import { defineFixture } from '../../../../component-fixtures/component-fixture'
import { makeRepo, makeWorktree } from '../../../worktree-jump/worktree-jump-palette-test-fixtures'
import type { EphemeralVmWorkspaceRuntime } from '@/store/slices/ephemeral-vm/ephemeral-vm-lifecycle'
import WorktreeCard from './WorktreeCard'

const repo = { ...makeRepo(), displayName: 'orca' }

const cases: {
  id: string
  name: string
  status: EphemeralVmRuntimeStatus
  waking?: boolean
  failure?: EphemeralVmWorkspaceRuntime['failure']
}[] = [
  { id: 'vm-provisioning', name: 'Provisioning VM', status: 'provisioning' },
  { id: 'vm-suspended', name: 'Suspended VM', status: 'suspended' },
  { id: 'vm-waking', name: 'Waking VM', status: 'suspended', waking: true },
  {
    id: 'vm-resume-failed',
    name: 'Resume failed VM',
    status: 'resume_failed',
    failure: {
      error: 'Resume exited with code 3.',
      errorCode: 'resumeExited',
      errorParams: { exitCode: 3 }
    }
  },
  {
    id: 'vm-setup-failed',
    name: 'Setup failed VM',
    status: 'failed',
    failure: { error: 'Provisioning was interrupted.', errorCode: 'provisionInterrupted' }
  },
  { id: 'vm-running', name: 'Running VM', status: 'running' }
]

const worktrees = cases.map((entry) =>
  makeWorktree(entry.id, entry.name, { branch: `refs/heads/${entry.id}` })
)

/** Real sidebar cards for each VM lifecycle state; a running VM keeps its normal status. */
export const cards = defineFixture({
  width: 320,
  store: {
    settings: getDefaultSettings('/home/fixture'),
    repos: [repo],
    worktreesByRepo: { [repo.id]: worktrees },
    worktreeCardProperties: ['status', 'branch'],
    ephemeralVmRuntimesByWorkspaceId: Object.fromEntries(
      cases.map((entry) => [
        entry.id,
        {
          id: `runtime-${entry.id}`,
          workspaceId: entry.id,
          status: entry.status,
          runtimeEnvironmentId: `env-${entry.id}`,
          canSuspend: true,
          ...(entry.failure ? { failure: entry.failure } : {})
        }
      ])
    ),
    wakingEphemeralVmWorkspaceIds: Object.fromEntries(
      cases.filter((entry) => entry.waking).map((entry) => [entry.id, true])
    )
  },
  render: () => (
    <div className="flex flex-col gap-1 bg-worktree-sidebar p-2 text-worktree-sidebar-foreground">
      {worktrees.map((worktree) => (
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
})
