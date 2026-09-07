import { toast } from 'sonner'
import type { GlobalSettings } from '../../../shared/global-settings-types'
import { translate } from '@/i18n/i18n'
import { isLocalWorkspaceWindowEnvironment } from './workspace-window-runtime-scope'

export function isLocalPathOpenBlocked(
  settings: Pick<GlobalSettings, 'activeRuntimeEnvironmentId'> | null | undefined,
  context?: { connectionId?: string | null }
): boolean {
  const environmentId = settings?.activeRuntimeEnvironmentId?.trim()
  return Boolean(
    (environmentId && !isLocalWorkspaceWindowEnvironment(environmentId)) ||
    context?.connectionId?.trim()
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
