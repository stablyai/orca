import { toast } from 'sonner'
import type { GlobalSettings } from '../../../shared/global-settings-types'
import { translate } from '@/i18n/i18n'

export function isLocalPathOpenBlocked(
  settings: Pick<GlobalSettings, 'activeRuntimeEnvironmentId'> | null | undefined,
  context?: {
    connectionId?: string | null
    runtimeEnvironmentId?: string | null
    /** The path's owner could not be placed; a null runtime then proves nothing about locality. */
    ownerUnresolved?: boolean
  }
): boolean {
  return Boolean(
    context?.ownerUnresolved ||
    settings?.activeRuntimeEnvironmentId?.trim() ||
    context?.connectionId?.trim() ||
    context?.runtimeEnvironmentId?.trim()
  )
}

export function showLocalPathOpenBlockedToast(): void {
  // Why: local OS reveal/open actions receive client filesystem paths. Remote
  // runtime and SSH paths belong to another machine, not this client.
  toast.error(
    translate(
      'auto.lib.local.path.open.guard.edc1908653',
      'Opening remote paths in the local OS is not available.'
    )
  )
}
