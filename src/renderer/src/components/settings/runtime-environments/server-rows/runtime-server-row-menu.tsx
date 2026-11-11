import {
  ArrowUpCircle,
  Info,
  KeyRound,
  RefreshCw,
  Server,
  ServerOff,
  Star,
  Trash2,
  Waypoints
} from 'lucide-react'
import { useTranslate } from '@/i18n/use-translate'
import {
  getUpdateCheckClickOptions,
  getUpdateCheckHint
} from '@/app-shell/updates/update-check-click-options'
import type { UpdateCheckOptions } from '../../../../../../shared/update-status-types'
import { DropdownMenuItem, DropdownMenuSeparator } from '../../../ui/dropdown-menu'

type RuntimeServerRowMenuProps = {
  showUpdate: boolean
  showConnect: boolean
  showDisconnect: boolean
  showMakeDefault: boolean
  /** null hides the item; otherwise whether the route is already linked. */
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
  onEdgeAuth?: () => void
  onSshAccess: () => void
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
  onEdgeAuth,
  onSshAccess,
  onToggleDetails,
  onRemove
}: RuntimeServerRowMenuProps): React.JSX.Element {
  const t = useTranslate()
  return (
    <>
      {showUpdate ? (
        <DropdownMenuItem onSelect={onUpdate}>
          <ArrowUpCircle />
          {t('auto.components.settings.serverList.updateMenu', 'Update…')}
        </DropdownMenuItem>
      ) : null}
      {showDisconnect ? (
        <DropdownMenuItem disabled={actionBusy} onSelect={onDisconnect}>
          <ServerOff />
          {t('auto.components.settings.RuntimeEnvironmentsPane.disconnect', 'Disconnect')}
        </DropdownMenuItem>
      ) : null}
      {showConnect ? (
        <DropdownMenuItem disabled={actionBusy || connectDisabled} onSelect={onConnect}>
          <Server />
          {t('auto.components.settings.RuntimeEnvironmentsPane.connect', 'Connect')}
        </DropdownMenuItem>
      ) : null}
      {showMakeDefault ? (
        <DropdownMenuItem disabled={isBusy} onSelect={onMakeDefault}>
          <Star />
          {t('auto.components.settings.serverList.makeDefault', 'Open new projects here')}
        </DropdownMenuItem>
      ) : null}
      <DropdownMenuSeparator />
      {sshAccessLinked !== null ? (
        <DropdownMenuItem onSelect={onSshAccess}>
          <Waypoints />
          {sshAccessLinked
            ? t('auto.components.settings.serverList.sshAccessLinked', 'SSH route…')
            : t('auto.components.settings.serverList.sshAccess', 'Connect through SSH…')}
        </DropdownMenuItem>
      ) : null}
      {onEdgeAuth ? (
        <DropdownMenuItem onSelect={onEdgeAuth} disabled={actionBusy}>
          <KeyRound />
          {t('settings.edgeAuth.menu', 'Edge authentication…')}
        </DropdownMenuItem>
      ) : null}
      {onCheckForUpdates ? (
        <DropdownMenuItem
          title={getUpdateCheckHint()}
          onClick={(event) => onCheckForUpdates(getUpdateCheckClickOptions(event))}
        >
          <RefreshCw />
          {t('auto.components.settings.serverList.checkForUpdates', 'Check for updates')}
        </DropdownMenuItem>
      ) : null}
      <DropdownMenuItem onSelect={onToggleDetails}>
        <Info />
        {detailsExpanded
          ? t('auto.components.settings.serverList.hideDetails', 'Hide details')
          : t('auto.components.settings.serverList.details', 'Details')}
      </DropdownMenuItem>
      <DropdownMenuSeparator />
      {managedItems}
      <DropdownMenuItem variant="destructive" disabled={isBusy} onSelect={onRemove}>
        <Trash2 />
        {t('auto.components.settings.serverList.remove', 'Remove…')}
      </DropdownMenuItem>
    </>
  )
}
