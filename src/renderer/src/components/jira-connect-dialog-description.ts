import { translate } from '@/i18n/i18n'

export function jiraConnectDialogDescription(args: {
  isServer: boolean
  isServerBasic: boolean
}): string {
  if (!args.isServer) {
    return translate(
      'auto.components.jira.connect.dialog.d785c42b8b',
      'Use a Jira Cloud site URL, Atlassian email, and API token to browse issues.'
    )
  }
  if (args.isServerBasic) {
    return translate(
      'auto.components.jira.connect.dialog.1d947a07ab',
      'Use a self-hosted Jira base URL, username, and password to browse issues.'
    )
  }
  return translate(
    'auto.components.jira.connect.dialog.2e2b69e48e',
    'Use a self-hosted Jira base URL and a personal access token to browse issues.'
  )
}

export function jiraConnectDialogCancelLabel(): string {
  return translate('auto.components.jira.connect.dialog.79e7aaed39', 'Cancel')
}

export function jiraConnectDialogSubmitLabel(connecting: boolean): string {
  return connecting
    ? translate('auto.components.jira.connect.dialog.4a2ab52781', 'Verifying…')
    : translate('auto.components.jira.connect.dialog.63ce735809', 'Connect')
}
