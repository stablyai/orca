import React from 'react'
import { Loader2 } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { translate } from '@/i18n/i18n'
import { openWslHostsExperimentalSetting } from '../sidebar/use-wsl-hosts-enabled'
import { getWslHostsTurnedOffLabel, getWslHostsTurnOnLabel } from '../sidebar/wsl-host-row-status'
import type { MachineMatch } from '@/lib/machines/machine-host-match'
import { getMachineMenuActions } from '@/lib/machines/machine-actions'
import { wakeStoppedMachine } from '@/lib/machines/machine-wake-on-open'
import { getStoppedMachineTitle } from '@/lib/machines/machine-copy'

type FileExplorerTreeStatusProps = {
  isLoading: boolean
  error: string | null
  isEmpty: boolean
  scopedToFolder?: boolean
  emptyMessage?: string
  /** The workspace's WSL host is turned off: offer the switch instead of a read error. */
  wslHostsTurnedOff?: boolean
  /** The workspace's machine sleeps, is archived or is gone: say why instead of a read error. */
  stoppedMachine?: MachineMatch | null
}

/** Treats even an empty error message as a failed read, keeping unreadable directories distinct from empty ones. */
export function FileExplorerTreeStatus({
  isLoading,
  error,
  isEmpty,
  emptyMessage,
  scopedToFolder = false,
  wslHostsTurnedOff = false,
  stoppedMachine = null
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

  if (error !== null && stoppedMachine) {
    return (
      <div
        className="flex h-full flex-col items-center justify-center gap-2 px-4 text-center text-[11px] text-muted-foreground"
        data-file-explorer-stopped-machine={stoppedMachine.machine.state}
      >
        <span>{getStoppedMachineTitle(stoppedMachine)}</span>
        {getMachineMenuActions(stoppedMachine).includes('wake') ? (
          <Button size="xs" onClick={() => void wakeStoppedMachine(stoppedMachine)}>
            {translate('auto.components.machines.StoppedMachineBanner.wake', 'Wake machine')}
          </Button>
        ) : null}
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
