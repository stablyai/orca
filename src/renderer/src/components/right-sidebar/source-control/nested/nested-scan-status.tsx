import React from 'react'
import { Loader2 } from 'lucide-react'
import { translate } from '@/i18n/i18n'
import type { NestedFolderScope } from './use-nested-folder-scope'

export function NestedScanStatus({
  scope
}: {
  scope: NestedFolderScope
}): React.JSX.Element | null {
  if (!scope.folderPath) {
    return null
  }

  if (scope.scanning && scope.statuses.length === 0) {
    return (
      <div className="flex items-center gap-1.5 px-3 py-2 text-[11px] text-muted-foreground">
        <Loader2 className="size-3 animate-spin" />
        {translate('sourceControl.nestedFolder.scanning', 'Looking for git repos…')}
      </div>
    )
  }

  if (scope.scanError) {
    return <p className="px-3 py-2 text-[11px] text-destructive">{scope.scanError}</p>
  }

  if (scope.repos.length === 0 && !scope.scanning) {
    return (
      <p className="px-3 py-2 text-[11px] text-muted-foreground">
        {translate('sourceControl.nestedFolder.empty', 'No git repos in this folder')}
      </p>
    )
  }

  return null
}
