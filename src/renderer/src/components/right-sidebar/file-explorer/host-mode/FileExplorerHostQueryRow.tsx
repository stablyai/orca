import React from 'react'
import { useTranslate } from '@/i18n/use-translate'
import type { RightSidebarExplorerView } from '../../../../../../shared/ui-chrome-types'
import { FileExplorerNameFilter } from '../panel/FileExplorerNameFilter'
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
  const t = useTranslate()
  const { active, filterQuery, setFilterQuery } = useFileExplorerHostModeContext()
  if (!active) {
    return null
  }
  return (
    <div className="absolute inset-0 z-10 bg-background">
      {view === 'search' ? (
        <p className="flex min-h-7 items-center text-[11px] text-muted-foreground">
          {t(
            'fileExplorer.host.contentsUnavailable',
            'Contents search covers the workspace. Return to the workspace root to use it.'
          )}
        </p>
      ) : (
        <FileExplorerNameFilter
          query={filterQuery}
          scopeLabel={t('fileExplorer.host.thisFolder', 'this folder')}
          onQueryChange={setFilterQuery}
          onClear={() => setFilterQuery('')}
        />
      )}
    </div>
  )
}
