import React from 'react'
import type { CloudOpenCover } from '@/lib/orca-cloud/cloud-open-cover-store'
import WorktreeCreationTabStrip from './WorktreeCreationTabStrip'
import { VmBuildSheet } from './VmBuildSheet'

const noop = (): void => {}

/** The creation panel's last frame, laid out exactly like WorktreeCreationPanel. */
export default function CloudOpenCoverBody({
  cover,
  now,
  reserveCollapsedSidebarHeaderSpace
}: {
  cover: CloudOpenCover
  now: number
  reserveCollapsedSidebarHeaderSpace: boolean
}): React.JSX.Element {
  const { entry } = cover
  return (
    <div data-cloud-open-cover="" className="absolute inset-0 z-20 flex flex-col bg-background">
      <WorktreeCreationTabStrip
        title={entry.request.displayName || entry.request.name}
        isError={false}
        reserveCollapsedSidebarHeaderSpace={reserveCollapsedSidebarHeaderSpace}
        onCancel={noop}
      />
      {/* A picture of the last frame: nothing in it is interactive. */}
      <div className="min-h-0 flex-1 p-3" inert>
        <VmBuildSheet
          creationId={entry.creationId}
          entry={entry}
          now={now}
          elapsedLabel=""
          error={null}
          onCancel={noop}
          onRetry={noop}
          onDismiss={noop}
          onReturnToComposer={noop}
          onEditRecipe={noop}
        />
      </div>
    </div>
  )
}
