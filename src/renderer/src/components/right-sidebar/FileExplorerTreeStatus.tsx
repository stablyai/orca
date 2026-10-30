import React from 'react'
import { Loader2 } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { translate } from '@/i18n/i18n'
import { openWslHostsExperimentalSetting } from '../sidebar/use-wsl-hosts-enabled'
import { getWslHostsTurnedOffLabel, getWslHostsTurnOnLabel } from '../sidebar/wsl-host-row-status'

type FileExplorerTreeStatusProps = {
  isLoading: boolean
  error: string | null
  isEmpty: boolean
  scopedToFolder?: boolean
  emptyMessage?: string
  /** The workspace's WSL host is turned off: offer the switch instead of a read error. */
  wslHostsTurnedOff?: boolean
}

/** Treats even an empty error message as a failed read, keeping unreadable directories distinct from empty ones. */
export function FileExplorerTreeStatus({
  isLoading,
  error,
  isEmpty,
  emptyMessage,
  scopedToFolder = false,
  wslHostsTurnedOff = false
}: FileExplorerTreeStatusProps): React.JSX.Element | null {
  if (isLoading) {
    return (
      <div className="flex h-full items-center justify-center text-[11px] text-muted-foreground">
        <Loader2 className="size-4 animate-spin" />
      </div>
    )
  }

  if (error !== null && wslHostsTurnedOff) {
    return (
      <div
        className="flex h-full flex-col items-center justify-center gap-2 px-4 text-center text-[11px] text-muted-foreground"
        data-file-explorer-wsl-hosts-turned-off=""
      >
        <span>{getWslHostsTurnedOffLabel()}</span>
        <Button size="xs" onClick={openWslHostsExperimentalSetting}>
          {getWslHostsTurnOnLabel()}
        </Button>
      </div>
    )
  }

  if (error !== null) {
    return (
      <div className="flex h-full items-center justify-center px-4 text-center text-[11px] text-muted-foreground">
        {scopedToFolder
          ? translate('fileExplorer.root.folderLoadError', 'Could not load this folder:')
          : translate(
              'auto.components.right.sidebar.FileExplorerTreeStatus.c76693e456',
              'Could not load files for this workspace:'
            )}{' '}
        {error}
      </div>
    )
  }

  if (isEmpty) {
    return (
      <div className="flex h-full items-center justify-center px-4 text-center text-[11px] text-muted-foreground">
        {emptyMessage ??
          (scopedToFolder
            ? translate('fileExplorer.root.emptyFolder', 'No files in this folder')
            : translate(
                'auto.components.right.sidebar.FileExplorerTreeStatus.ce03835e1f',
                'No files in this workspace'
              ))}
      </div>
    )
  }

  return null
}
