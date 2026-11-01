import { translate } from '@/i18n/i18n'

export function jiraCredentialStorageCopy(remoteRuntime: boolean): string {
  return remoteRuntime
    ? translate(
        'taskProviders.jira.remoteTokenStorage',
        'Your token is sent to the selected remote runtime and stored there with runtime-supported encryption.'
      )
    : translate(
        'taskProviders.jira.localTokenStorage',
        'Your token is stored locally and encrypted when local runtime storage supports it.'
      )
}
