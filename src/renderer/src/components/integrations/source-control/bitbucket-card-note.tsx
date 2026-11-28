import type { BitbucketStatus } from './integrations-pane-status'
import { useTranslate } from '@/i18n/use-translate'

export function BitbucketCardNote(props: {
  envManaged: boolean
  status: BitbucketStatus | 'unavailable'
  storedCredential: boolean
  /** The credential lives on the selected remote server, not this computer. */
  remoteHost: boolean
}): React.JSX.Element {
  const t = useTranslate()
  if (props.status === 'unavailable') {
    return (
      <p className="text-xs text-muted-foreground">
        {t(
          'auto.components.settings.token.source.control.integration.cards.24ac1c69dc',
          'Bitbucket status is not available in this runtime yet.'
        )}
      </p>
    )
  }
  if (props.envManaged) {
    return (
      <p className="text-xs text-muted-foreground">
        {t(
          'auto.components.settings.bitbucket.integration.card.envManaged',
          'Configured via environment variables. Unset the ORCA_BITBUCKET_* variables to manage this credential in Orca.'
        )}
      </p>
    )
  }
  if (props.status === 'not-authenticated') {
    return (
      <p className="text-xs text-muted-foreground">
        {props.storedCredential
          ? t(
              'auto.components.settings.bitbucket.integration.card.storedAuthFailed',
              'The saved Bitbucket credential could not authenticate. Edit it, or check that the token still has pull request access.'
            )
          : t(
              'auto.components.settings.token.source.control.integration.cards.6154b02093',
              'Bitbucket credentials are configured but could not authenticate. Check the token and repository permissions, then restart Orca if environment variables changed.'
            )}
      </p>
    )
  }
  if (props.storedCredential) {
    return (
      <p className="text-xs text-muted-foreground">
        {props.remoteHost
          ? t(
              'auto.components.settings.bitbucket.integration.card.storedCredentialRemote',
              'Saved in Orca on the selected server. ORCA_BITBUCKET_* environment variables there take precedence when set.'
            )
          : t(
              'auto.components.settings.bitbucket.integration.card.storedCredential',
              'Saved in Orca on this machine. ORCA_BITBUCKET_* environment variables take precedence when set.'
            )}
      </p>
    )
  }
  return (
    <p className="text-xs text-muted-foreground">
      {t(
        'auto.components.settings.bitbucket.integration.card.notConfigured',
        'Connect a Bitbucket Cloud account with an Atlassian API token or an access token. ORCA_BITBUCKET_* environment variables work too and take precedence.'
      )}
    </p>
  )
}
