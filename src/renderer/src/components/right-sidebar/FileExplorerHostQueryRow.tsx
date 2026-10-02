import React from 'react'
import { translate } from '@/i18n/i18n'
import type { RightSidebarExplorerView } from '../../../../shared/ui-chrome-types'
import { FileExplorerNameFilter } from './FileExplorerNameFilter'
import { useFileExplorerHostModeContext } from './file-explorer-host-mode-context-value'

/**
 * Host mode filters only the listed folder; Contents search stays scoped to Project mode. It covers
 * the Names/Contents slot in place so the Project query rows stay mounted and nothing shifts.
 */
export function FileExplorerHostQueryRow({
  view
}: {
  view: RightSidebarExplorerView
}): React.JSX.Element | null {
  const { active, filterQuery, setFilterQuery } = useFileExplorerHostModeContext()
  if (!active) {
    return null
  }
  return (
    <div className="absolute inset-0 z-10 bg-background">
      {view === 'search' ? (
        <p className="flex min-h-7 items-center text-[11px] text-muted-foreground">
          {translate(
            'fileExplorer.host.contentsUnavailable',
            'Contents search covers the workspace. Return to the workspace root to use it.'
          )}
        </p>
      ) : (
        <FileExplorerNameFilter
          query={filterQuery}
          scopeLabel={translate('fileExplorer.host.thisFolder', 'this folder')}
          onQueryChange={setFilterQuery}
          onClear={() => setFilterQuery('')}
        />
      )}
    </div>
  )
}
