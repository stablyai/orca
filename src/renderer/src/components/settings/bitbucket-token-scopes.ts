import { translate } from '@/i18n/i18n'
import type { AtlassianTokenScopeGroup } from '../atlassian-token-scope-list'

// Why: per Bitbucket's OpenAPI spec, /user needs read:user, build statuses need
// read:repository, and creating a pull request adds write:pullrequest.
export function bitbucketTokenScopeGroups(): AtlassianTokenScopeGroup[] {
  return [
    {
      id: 'read',
      label: translate('auto.components.settings.bitbucket.token.scopes.read', 'Verify and read'),
      scopes: ['read:user:bitbucket', 'read:repository:bitbucket', 'read:pullrequest:bitbucket']
    },
    {
      id: 'write',
      label: translate(
        'auto.components.settings.bitbucket.token.scopes.write',
        'Create pull requests'
      ),
      scopes: ['write:pullrequest:bitbucket']
    }
  ]
}
