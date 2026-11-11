import { Fragment } from 'react'
import { useTranslate } from '@/i18n/use-translate'

// Matches the endpoints in main/bitbucket: user-request.ts, client.ts and pull-request-creation.ts.
export function BitbucketApiTokenScopes(): React.JSX.Element {
  const t = useTranslate()
  const scopes = [
    {
      scope: 'read:user:bitbucket',
      purpose: t(
        'auto.components.settings.bitbucket.credentials.dialog.scopeUser',
        'Verify your account'
      )
    },
    {
      scope: 'read:repository:bitbucket',
      purpose: t(
        'auto.components.settings.bitbucket.credentials.dialog.scopeRepository',
        'Read build statuses'
      )
    },
    {
      scope: 'read:pullrequest:bitbucket',
      purpose: t(
        'auto.components.settings.bitbucket.credentials.dialog.scopeReadPullRequest',
        'Read pull requests'
      )
    },
    {
      scope: 'write:pullrequest:bitbucket',
      purpose: t(
        'auto.components.settings.bitbucket.credentials.dialog.scopeWritePullRequest',
        'Create pull requests'
      )
    }
  ]
  return (
    <div className="space-y-2">
      <p>
        {t(
          'auto.components.settings.bitbucket.credentials.dialog.scopesTitle',
          'Select these Bitbucket API token scopes:'
        )}
      </p>
      <dl className="grid grid-cols-[auto_minmax(0,1fr)] gap-x-3 gap-y-1">
        {scopes.map(({ scope, purpose }) => (
          <Fragment key={scope}>
            <dt className="font-mono break-all text-foreground">{scope}</dt>
            <dd>{purpose}</dd>
          </Fragment>
        ))}
      </dl>
      <p>
        {t(
          'auto.components.settings.bitbucket.credentials.dialog.scopesWriteNote',
          'For read-only use, omit the write scope. Write does not include read; select each scope separately.'
        )}
      </p>
    </div>
  )
}
