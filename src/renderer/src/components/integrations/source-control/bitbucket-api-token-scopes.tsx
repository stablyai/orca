import { translate } from '@/i18n/i18n'

export function BitbucketApiTokenScopes(): React.JSX.Element {
  const scopes = [
    {
      scope: 'read:user:bitbucket',
      purpose: translate('bitbucket.apiTokenScopes.user', 'Verify your account')
    },
    {
      scope: 'read:repository:bitbucket',
      purpose: translate('bitbucket.apiTokenScopes.repository', 'Read build statuses')
    },
    {
      scope: 'read:pullrequest:bitbucket',
      purpose: translate('bitbucket.apiTokenScopes.readPullRequest', 'Read pull requests')
    },
    {
      scope: 'write:pullrequest:bitbucket',
      purpose: translate('bitbucket.apiTokenScopes.writePullRequest', 'Create pull requests')
    }
  ]
  return (
    <div className="space-y-2 text-xs leading-relaxed text-muted-foreground">
      <p>
        {translate('bitbucket.apiTokenScopes.title', 'Select these Bitbucket API token scopes:')}
      </p>
      <dl className="space-y-1">
        {scopes.map(({ scope, purpose }) => (
          <div key={scope}>
            <dt className="font-mono break-all text-foreground">{scope}</dt>
            <dd>{purpose}</dd>
          </div>
        ))}
      </dl>
      <p>
        {translate(
          'bitbucket.apiTokenScopes.writeNote',
          'For read-only use, omit the write scope. Write does not include read; select each scope separately.'
        )}
      </p>
    </div>
  )
}
