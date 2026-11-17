// The team list's read-only view of an Asleep workspace: what it looked like when it went to
// sleep, read from the copy it sealed to this computer's key. Opening it never wakes the sandbox;
// "Wake to continue" runs the normal open flow.
import React, { useEffect, useRef, useState } from 'react'
import { Sheet, SheetContent, SheetTitle } from '@/components/ui/sheet'
import { installWindowVisibilityInterval } from '@/lib/window-activity/window-visibility-interval'
import type { CloudWorkspace } from '../../../../shared/cloud-workspaces/cloud-workspaces-wire'
import {
  CloudReadSnapshotView,
  type CloudReadWake
} from '../orca-cloud/read-snapshot/CloudReadSnapshotView'
import { cloudWorkspaceTitle } from './open-cloud-workspace'
import { useCloudReadSnapshot } from './use-cloud-read-snapshot'

export function CloudReadSnapshotSheet({
  workspace,
  wake,
  onWake,
  onClose
}: {
  /** Null keeps the sheet closed. */
  workspace: CloudWorkspace | null
  wake: CloudReadWake | null
  onWake: (w: CloudWorkspace) => void
  onClose: () => void
}): React.JSX.Element {
  const { state, retry, retrying } = useCloudReadSnapshot(workspace?.id ?? null)
  const [now, setNow] = useState(() => Date.now())
  const headingRef = useRef<HTMLHeadingElement>(null)
  useEffect(() => {
    if (!workspace) {
      return
    }
    setNow(Date.now())
    return installWindowVisibilityInterval({ run: () => setNow(Date.now()), intervalMs: 30_000 })
  }, [workspace])
  const title = workspace ? cloudWorkspaceTitle(workspace) : ''
  return (
    <Sheet open={workspace !== null} onOpenChange={(open) => !open && onClose()}>
      <SheetContent
        className="w-full sm:max-w-xl"
        aria-describedby={undefined}
        // Land on the title, not on "Wake to continue": opening to read must never be one Enter
        // away from waking the sandbox.
        onOpenAutoFocus={(event) => {
          event.preventDefault()
          headingRef.current?.focus()
        }}
      >
        {/* The view's own heading is the visible title; Radix needs one for the dialog name. */}
        <SheetTitle className="sr-only">{title}</SheetTitle>
        {workspace ? (
          // The sheet owns its frame; this wrapper scrolls and pads (clear of the close button).
          <div className="min-h-0 flex-1 overflow-y-auto scrollbar-sleek p-6 pr-12">
            <CloudReadSnapshotView
              title={title}
              state={state}
              now={now}
              wake={wake}
              onWake={() => onWake(workspace)}
              onRetry={retry}
              retrying={retrying}
              headingRef={headingRef}
            />
          </div>
        ) : null}
      </SheetContent>
    </Sheet>
  )
}
