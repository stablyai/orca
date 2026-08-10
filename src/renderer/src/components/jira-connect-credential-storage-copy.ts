import { translate } from '@/i18n/i18n'
import type { GlobalSettings } from '../../../shared/types'
import { hasRemoteProviderRuntime } from '@/lib/provider-runtime-context'

export function jiraConnectCredentialStorageCopy(
  settings: Pick<GlobalSettings, 'activeRuntimeEnvironmentId'> | null | undefined
): string {
  return hasRemoteProviderRuntime(settings)
    ? translate(
        'auto.components.jiraConnectDialog.tokenStoredRemote',
        'Your token is sent to the selected remote runtime and stored there with runtime-supported encryption.'
      )
    : translate(
        'auto.components.jiraConnectDialog.tokenStoredLocal',
        'Your token is stored locally and encrypted when local runtime storage supports it.'
      )
}
