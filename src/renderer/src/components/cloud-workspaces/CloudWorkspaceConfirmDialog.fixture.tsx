import { defineFixture } from '../../component-fixtures/component-fixture'
import { CloudWorkspaceConfirmDialog } from './CloudWorkspaceConfirmDialog'
import { DIRECTORY, SELF_ID, workspace } from './cloud-workspaces.test-fixture'

const SHARED = workspace({ title: 'Checkout retries' })

const frame = (node: React.ReactNode): React.JSX.Element => <div className="h-[260px]">{node}</div>

/** A member giving their own workspace away is told they lose management of it. */
export const reassignAsMember = defineFixture({
  width: 640,
  render: () =>
    frame(
      <CloudWorkspaceConfirmDialog
        pending={{ kind: 'owner', workspace: SHARED, ownerUserId: 'user_grace' }}
        directory={DIRECTORY}
        selfId={SELF_ID}
        canAdmin={false}
        onCancel={() => {}}
        onConfirm={() => {}}
      />
    )
})

export const reassignAsAdmin = defineFixture({
  width: 640,
  render: () =>
    frame(
      <CloudWorkspaceConfirmDialog
        pending={{ kind: 'owner', workspace: SHARED, ownerUserId: 'user_linus' }}
        directory={DIRECTORY}
        selfId={SELF_ID}
        canAdmin
        onCancel={() => {}}
        onConfirm={() => {}}
      />
    )
})

/** Archiving a teammate's running workspace from the team list stops their agents (DS-01). */
export const archiveTeammateRunning = defineFixture({
  width: 640,
  render: () =>
    frame(
      <CloudWorkspaceConfirmDialog
        pending={{
          kind: 'archive',
          workspace: workspace({
            title: 'Checkout retries',
            ownerUserId: 'user_grace',
            status: 'running'
          })
        }}
        directory={DIRECTORY}
        selfId={SELF_ID}
        canAdmin
        onCancel={() => {}}
        onConfirm={() => {}}
      />
    )
})

/** Deleting a workspace from the team list (one this computer doesn't run): DS-07 copy. */
export const deleteFromTeamList = defineFixture({
  width: 640,
  render: () =>
    frame(
      <CloudWorkspaceConfirmDialog
        pending={{ kind: 'delete', workspace: workspace({ title: 'Checkout retries' }) }}
        directory={DIRECTORY}
        selfId={SELF_ID}
        canAdmin
        onCancel={() => {}}
        onConfirm={() => {}}
      />
    )
})
