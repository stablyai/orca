import {
  ArrowUpCircle,
  Info,
  Plug,
  RefreshCw,
  Server,
  ServerOff,
  Star,
  Trash2,
  Waypoints
} from 'lucide-react'
import { translate } from '@/i18n/i18n'
import { getUpdateCheckClickOptions, getUpdateCheckHint } from '@/lib/update-check-click-options'
import type { UpdateCheckOptions } from '../../../../shared/update-status-types'
import { DropdownMenuItem, DropdownMenuSeparator } from '../ui/dropdown-menu'

type RuntimeServerRowMenuProps = {
  showUpdate: boolean
  showConnect: boolean
  showDisconnect: boolean
  showMakeDefault: boolean
  /** null hides the items; otherwise whether the route is already linked. */
  sshAccessLinked: boolean | null
  detailsExpanded: boolean
  actionBusy: boolean
  isBusy: boolean
  connectDisabled: boolean
  /** Managed-server lifecycle items, placed between setup and removal. */
  managedItems?: React.ReactNode
  onUpdate: () => void
  onConnect: () => void
  onDisconnect: () => void
  onMakeDefault: () => void
  onCheckForUpdates?: (options: UpdateCheckOptions) => void
  onSshAccess: () => void
  onSshPorts: () => void
  onToggleDetails: () => void
  onRemove: () => void
}

export function RuntimeServerRowMenuItems({
  showUpdate,
  showConnect,
  showDisconnect,
  showMakeDefault,
  sshAccessLinked,
  detailsExpanded,
  actionBusy,
  isBusy,
  connectDisabled,
  managedItems,
  onUpdate,
  onConnect,
  onDisconnect,
  onMakeDefault,
  onCheckForUpdates,
  onSshAccess,
  onSshPorts,
  onToggleDetails,
  onRemove
}: RuntimeServerRowMenuProps): React.JSX.Element {
  return (
    <>
      {showUpdate ? (
        <DropdownMenuItem onSelect={onUpdate}>
          <ArrowUpCircle />
          {translate('auto.components.settings.serverList.updateMenu', 'Update…')}
        </DropdownMenuItem>
      ) : null}
      {showDisconnect ? (
        <DropdownMenuItem disabled={actionBusy} onSelect={onDisconnect}>
          <ServerOff />
          {translate('auto.components.settings.RuntimeEnvironmentsPane.disconnect', 'Disconnect')}
        </DropdownMenuItem>
      ) : null}
      {showConnect ? (
        <DropdownMenuItem disabled={actionBusy || connectDisabled} onSelect={onConnect}>
          <Server />
          {translate('auto.components.settings.RuntimeEnvironmentsPane.connect', 'Connect')}
        </DropdownMenuItem>
      ) : null}
      {showMakeDefault ? (
        <DropdownMenuItem disabled={isBusy} onSelect={onMakeDefault}>
          <Star />
          {translate('auto.components.settings.serverList.makeDefault', 'Open new projects here')}
        </DropdownMenuItem>
      ) : null}
      <DropdownMenuSeparator />
      {sshAccessLinked !== null ? (
        <DropdownMenuItem onSelect={onSshAccess}>
          <Waypoints />
          {sshAccessLinked
            ? translate('auto.components.settings.serverList.sshAccessLinked', 'SSH route…')
            : translate('auto.components.settings.serverList.sshAccess', 'Connect through SSH…')}
        </DropdownMenuItem>
      ) : null}
      {sshAccessLinked === false ? (
        <DropdownMenuItem onSelect={onSshPorts}>
          <Plug />
          {translate('auto.components.settings.serverList.sshPorts', 'Forward ports through SSH…')}
        </DropdownMenuItem>
      ) : null}
      {onCheckForUpdates ? (
        <DropdownMenuItem
          title={getUpdateCheckHint()}
          onClick={(event) => onCheckForUpdates(getUpdateCheckClickOptions(event))}
        >
          <RefreshCw />
          {translate('auto.components.settings.serverList.checkForUpdates', 'Check for updates')}
        </DropdownMenuItem>
      ) : null}
      <DropdownMenuItem onSelect={onToggleDetails}>
        <Info />
        {detailsExpanded
          ? translate('auto.components.settings.serverList.hideDetails', 'Hide details')
          : translate('auto.components.settings.serverList.details', 'Details')}
      </DropdownMenuItem>
      <DropdownMenuSeparator />
      {managedItems}
      <DropdownMenuItem variant="destructive" disabled={isBusy} onSelect={onRemove}>
        <Trash2 />
        {translate('auto.components.settings.serverList.remove', 'Remove…')}
      </DropdownMenuItem>
    </>
  )
}
