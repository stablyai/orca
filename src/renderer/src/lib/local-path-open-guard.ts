import { toast } from 'sonner'
import type { GlobalSettings } from '../../../shared/global-settings-types'
import { translate } from '@/i18n/i18n'
import { settingsForRuntimeOwner } from '@/runtime/runtime-rpc-client'

export function isLocalPathOpenBlocked(
  settings: Pick<GlobalSettings, 'activeRuntimeEnvironmentId'> | null | undefined,
  context?: { connectionId?: string | null }
): boolean {
  return Boolean(settings?.activeRuntimeEnvironmentId?.trim() || context?.connectionId?.trim())
}

export function isLocalPathOpenBlockedForRuntimeOwner(
  settings: Pick<GlobalSettings, 'activeRuntimeEnvironmentId'> | null | undefined,
  runtimeEnvironmentId: string | null | undefined,
  context?: { connectionId?: string | null }
): boolean {
  return isLocalPathOpenBlocked(settingsForRuntimeOwner(settings, runtimeEnvironmentId), context)
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
