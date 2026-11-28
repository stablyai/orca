import { useTranslate } from '@/i18n/use-translate'
import type { PreflightStatusHost } from '@/store/slices/preflight/preflight'
import type { ProviderHostScope } from '../../provider-accounts/provider-account-scope'
import { useProviderAccountScope } from '../../provider-accounts/use-provider-host-scope'

/** Names the host the card's status and saves use, including when it follows the open workspace. */
export function useBitbucketHostScope(host: PreflightStatusHost | null): ProviderHostScope {
  const t = useTranslate()
  const scope = useProviderAccountScope(host?.target ?? { kind: 'local' })
  if (!host?.followsWorkspace) {
    return scope
  }
  return {
    label: scope.label,
    description: t(
      'auto.components.settings.bitbucket.integration.card.scopeFollowsWorkspace',
      'Checked on the host that runs the open workspace. Credentials saved here are stored on that host.'
    )
  }
}
