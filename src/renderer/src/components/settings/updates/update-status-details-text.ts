import type { Translate } from '@/i18n/use-translate'
import { updaterMessageText } from '@/app-shell/updates/updater-message-copy'
import { getUpdateInstallBlockGuidance } from '../../maintenance/update-card/update-install-block-guidance'
import type { UpdateStatus } from '../../../../../shared/updater/update-status-types'
import type { UpdateStatusRowModel } from './update-status-row-model'

/** The text kept behind the About status row's "Show details", or null when there is none. */
export function detailsText(
  model: UpdateStatusRowModel,
  status: UpdateStatus,
  t: Translate
): string | null {
  switch (model.details) {
    case null:
      return null
    case 'message':
      return status.state === 'error' ? updaterMessageText(status) : null
    case 'install-block': {
      if (status.state !== 'error' || !status.installBlock) {
        return null
      }
      const guidance = getUpdateInstallBlockGuidance(status.installBlock, t)
      const { reason, instances } = status.installBlock
      // The card's guidance points at a process list that About doesn't show, so name it here. Busy
      // and unresponsive blocks keep their own guidance, as on the card.
      if (
        reason === 'running-instances' &&
        instances.length > 0 &&
        instances.every(({ kind }) => kind === 'browser')
      ) {
        const pids = instances.map(({ pid }) => pid).join(', ')
        const line =
          instances.length === 1
            ? t(
                'settings.about.status.browserBlockGuidance',
                'End the browser process (PID {{pids}}), then retry. Its server keeps running.',
                { pids }
              )
            : t(
                'settings.about.status.browserBlockGuidanceMany',
                'End the browser processes (PIDs {{pids}}), then retry. Their servers keep running.',
                { pids }
              )
        return `${guidance.summary} ${line}`
      }
      return `${guidance.summary} ${guidance.explainer}`
    }
    case 'unsupported-system':
      return status.state === 'not-available' && status.unsupportedSystemUpdate
        ? t(
            'macosUpdateRequirement.settingsStatus',
            'Orca {{version}} requires macOS {{macos}} or later. This is the latest version for this Mac.',
            {
              version: status.unsupportedSystemUpdate.version,
              macos: status.unsupportedSystemUpdate.minimumMacosVersion
            }
          )
        : null
    case 'externally-managed':
      return status.state === 'available'
        ? t(
            'auto.components.settings.GeneralUpdateSettingsSection.externallyManagedVersionAvailable',
            'Version {{version}} is available. Update Orca through your system package manager — Orca cannot install this release itself.',
            { version: status.version }
          )
        : null
  }
}
