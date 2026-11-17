// ARCHIVE-NOW: the archived page right after Archive is pressed, while the archive still runs.
import React from 'react'
import { defineFixture } from '../../component-fixtures/component-fixture'
import { CloudArchivedWorkspaceView } from './CloudArchivedWorkspaceView'

const noop = (): void => {}
const LOADING = { status: 'loading' } as const

// Archived for real: Move to this computer next to Unarchive.
export const archivedActions = defineFixture({
  width: 820,
  render: () => <Archived load={{ status: 'ready', archive: null }} />
})

function Archived({
  load = LOADING,
  pending
}: {
  load?: React.ComponentProps<typeof CloudArchivedWorkspaceView>['load']
  pending?: React.ComponentProps<typeof CloudArchivedWorkspaceView>['pending']
}): React.JSX.Element {
  const [now] = React.useState(() => Date.now())
  return (
    <div className="relative h-[620px]">
      <CloudArchivedWorkspaceView
        workspaceName="fix-auth-redirect"
        archivedAt={now}
        expiresAt={pending ? null : now + 30 * 86_400_000}
        load={load}
        unarchiving={false}
        onUnarchive={noop}
        onRetry={noop}
        onOpenUrl={noop}
        now={now}
        onMove={noop}
        pending={pending}
      />
    </div>
  )
}

export const archivingUndo = defineFixture({
  width: 820,
  render: () => (
    <Archived
      pending={{
        startedAt: Date.now(),
        phase: 'undo',
        undo: noop,
        skipHook: noop,
        localCopy: { hasLocalCopy: true, editedHere: 2 }
      }}
    />
  )
})
export const archivingHook = defineFixture({
  width: 820,
  render: () => <Archived pending={{ startedAt: Date.now(), phase: 'archiving', step: 'hook' }} />
})
export const archivingHookFailed = defineFixture({
  width: 820,
  render: () => (
    <Archived
      pending={{
        startedAt: Date.now(),
        phase: 'hook-failed',
        decide: noop,
        failure: {
          state: 'failed',
          runs: [
            {
              path: '/vercel/sandbox/workspaces/fix-auth-redirect',
              exitCode: 7,
              timedOut: false,
              output: 'Deleting preview branch fix-auth-redirect…\nneon: 401 unauthorized\n'
            }
          ]
        }
      }}
    />
  )
})
