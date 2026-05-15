import { toast } from 'sonner'
import type { GlobalSettings } from '../../../shared/types'

export function isLocalPathOpenBlocked(
  settings: Pick<GlobalSettings, 'activeRuntimeEnvironmentId'> | null | undefined,
  context?: { connectionId?: string | null }
): boolean {
  return Boolean(settings?.activeRuntimeEnvironmentId?.trim() || context?.connectionId?.trim())
}

export function showLocalPathOpenBlockedToast(): void {
  // Why: local OS reveal/open actions receive client filesystem paths. Remote
  // runtime and SSH paths belong to another machine, not this client.
  toast.error('Opening remote paths in the local OS is not available.')
}
