import { translate } from '@/i18n/i18n'
import type { Translate } from '@/i18n/use-translate'

export function jiraCredentialStorageCopy(
  remoteRuntime: boolean,
  t: Translate = translate
): string {
  return remoteRuntime
    ? t(
        'taskProviders.jira.remoteTokenStorage',
        'Your token is sent to the selected remote runtime and stored there with runtime-supported encryption.'
      )
    : t(
        'taskProviders.jira.localTokenStorage',
        'Your token is stored locally and encrypted when local runtime storage supports it.'
      )
}
