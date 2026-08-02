import React from 'react'
import { FileExplorerViewSwitch } from './FileExplorerViewSwitch'
import type { RightSidebarExplorerView } from '../../../../shared/types'

type FileExplorerQueryStripProps = {
  view: RightSidebarExplorerView
  onSelectView: (view: RightSidebarExplorerView) => void
  children: React.ReactNode
}

export function FileExplorerQueryStrip({
  view,
  onSelectView,
  children
}: FileExplorerQueryStripProps): React.JSX.Element {
  return (
    <div className="border-b border-border px-2 py-1.5">
      {/* Why: show the active query field first; the Contents/Names switch sits
         underneath so it reads as choosing the mode for the field above. */}
      <div className="flex flex-col gap-1">
        {children}
        <FileExplorerViewSwitch view={view} onSelectView={onSelectView} />
      </div>
    </div>
  )
}
