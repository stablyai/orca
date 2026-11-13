// GH-CREATE-NO-ROW: a GitHub-only Orca Cloud create has a sidebar row while it builds, atop the list
// (it has no project here yet), with the cloud glyph from the start; the paired workspace's rows
// replace it on hand-off.
import { getDefaultSettings } from '../../../../../../shared/constants'
import { defineFixture } from '../../../../component-fixtures/component-fixture'
import { githubCreateRequest } from '@/lib/orca-cloud/start-cloud-workspace-from-github'
import type { PendingWorktreeCreation } from '@/lib/workspace/creation/pending-worktree-creation'
import { PendingWorktreeRow } from './PendingWorktreeRow'

const T0 = 1_700_000_000_000

function creation(
  creationId: string,
  patch: Partial<PendingWorktreeCreation> = {}
): PendingWorktreeCreation {
  return {
    creationId,
    phase: 'provisioning-vm',
    status: 'creating',
    startedAt: T0,
    indeterminate: false,
    loaderVisible: true,
    provisioningLog: '[orca-cloud] provisioning\n[orca-cloud] plan-clone',
    provisioningLogStamps: [T0, T0 + 400],
    request: githubCreateRequest({
      repoUrl: 'https://github.com/nwparker/orca-sandbox-push-test',
      fullName: 'nwparker/orca-sandbox-push-test',
      prompt: 'Add a push test',
      agent: 'claude',
      composerRepoId: 'repo'
    }),
    ...patch
  }
}

const rows = {
  building: creation('building'),
  opening: creation('opening', { phase: 'creating' }),
  failed: creation('failed', {
    status: 'error',
    error: 'Orca Cloud workspaces need a plan with cloud hours.',
    errorCode: 'cloudPlanRequired',
    provisioningLog: '[orca-cloud] provisioning\nOrca Cloud: included_hours_exhausted'
  })
}

/** The sidebar's top while three GitHub-only creates are in flight: building, opening, refused. */
export const githubOnlyPendingRows = defineFixture({
  width: 320,
  store: {
    settings: getDefaultSettings('/home/fixture'),
    pendingWorktreeCreations: rows,
    activePendingCreationId: 'building'
  },
  render: () => (
    <div className="flex flex-col gap-1.5 bg-worktree-sidebar p-2 text-worktree-sidebar-foreground">
      {Object.keys(rows).map((creationId) => (
        <PendingWorktreeRow key={creationId} creationId={creationId} repoName={null} />
      ))}
    </div>
  )
})
