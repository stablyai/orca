import { translate } from '@/i18n/i18n'

export function JiraConnectCredentialGuide({
  isServer,
  isServerBasic,
  supportsScopedTokens
}: {
  isServer: boolean
  isServerBasic: boolean
  supportsScopedTokens: boolean
}): React.JSX.Element {
  if (isServer) {
    return (
      <p className="text-xs text-muted-foreground">
        {isServerBasic
          ? translate(
              'auto.components.jira.connect.dialog.d8737db691',
              'Use your Jira Server or Data Center account username and password.'
            )
          : translate(
              'auto.components.jira.connect.dialog.ccfb086d3e',
              'Create a personal access token in your Jira profile under Personal Access Tokens.'
            )}
      </p>
    )
  }
  return (
    <div className="space-y-2 text-xs text-muted-foreground">
      <p>
        {translate('auto.components.jira.connect.dialog.8090504a3e', 'Create a token in')}{' '}
        <button
          type="button"
          className="text-primary underline-offset-2 hover:underline"
          onClick={() =>
            window.api.shell.openUrl('https://id.atlassian.com/manage-profile/security/api-tokens')
          }
        >
          {translate(
            'auto.components.jira.connect.dialog.fdd26d81cc',
            'Atlassian account settings'
          )}
        </button>
        .
      </p>
      <p>
        {supportsScopedTokens
          ? translate(
              'jira.connect.scopedTokenGuide',
              'Scoped tokens need read:jira-work, write:jira-work, and read:jira-user. Leave email empty to use Bearer authentication.'
            )
          : translate(
              'jira.connect.oldHostGuide',
              'This remote runtime requires an email and an unscoped API token. Update the remote runtime to use scoped tokens.'
            )}
      </p>
    </div>
  )
}
