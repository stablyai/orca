import React from 'react'
import { Loader2 } from 'lucide-react'
import { translate } from '@/i18n/i18n'

type FileExplorerTreeStatusProps = {
  isLoading: boolean
  error: string | null
  isEmpty: boolean
}

export function FileExplorerTreeStatus({
  isLoading,
  error,
  isEmpty
}: FileExplorerTreeStatusProps): React.JSX.Element | null {
  if (isLoading) {
    return (
      <div className="flex h-full items-center justify-center text-[11px] text-muted-foreground">
        <Loader2 className="size-4 animate-spin" />
      </div>
    )
  }

  if (error) {
    return (
      <div className="flex h-full items-center justify-center px-4 text-center text-[11px] text-muted-foreground">
        {translate("auto.components.right.sidebar.FileExplorerTreeStatus.c76693e456", "Could not load files for this workspace:")}{error}
      </div>
    )
  }

  if (isEmpty) {
    return (
      <div className="flex h-full items-center justify-center px-4 text-center text-[11px] text-muted-foreground">
        {translate("auto.components.right.sidebar.FileExplorerTreeStatus.ce03835e1f", "No files in this workspace")}</div>
    )
  }

  return null
}
