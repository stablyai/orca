import { defineFixture } from '../../component-fixtures/component-fixture'
import { CloudWorkspaceConfirmDialog } from './CloudWorkspaceConfirmDialog'
import { DIRECTORY, presence, SELF_ID, workspace } from './cloud-workspaces.test-fixture'
import type { CloudWorkspacesApi } from '../../../../preload/api/cloud-workspaces-api'

const SHARED = workspace({
  title: 'Checkout retries',
  presence: [presence('user_grace', 'typing'), presence('user_linus')]
})

function stubGrants(userIds: string[]): void {
  Object.assign(window.api.cloudWorkspaces, {
    listGrants: (id: string) =>
      Promise.resolve({
        ok: true as const,
        value: userIds.map((userId, index) => ({
          id: `grt_${String(index).padStart(24, '0')}`,
          workspaceId: id,
          userId,
          deviceKind: 'desktop' as const,
          deviceLabel: 'MacBook Pro',
          status: 'active' as const,
          createdAt: Date.now(),
          revokedAt: null
        }))
      })
  } satisfies Partial<CloudWorkspacesApi>)
}

const frame = (node: React.ReactNode): React.JSX.Element => <div className="h-[260px]">{node}</div>

/** Names everyone who loses access: teammates here now plus active device grants. */
export const makePrivate = defineFixture({
  width: 640,
  setup: () => stubGrants(['user_mae']),
  render: () =>
    frame(
      <CloudWorkspaceConfirmDialog
        pending={{ kind: 'private', workspace: SHARED }}
        directory={DIRECTORY}
        selfId={SELF_ID}
        canAdmin
        onCancel={() => {}}
        onConfirm={() => {}}
      />
    )
})

export const makePrivateNobodyConnected = defineFixture({
  width: 640,
  setup: () => stubGrants([]),
  render: () =>
    frame(
      <CloudWorkspaceConfirmDialog
        pending={{ kind: 'private', workspace: workspace({ title: 'Docs search' }) }}
        directory={DIRECTORY}
        selfId={SELF_ID}
        canAdmin
        onCancel={() => {}}
        onConfirm={() => {}}
      />
    )
})

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
