import { KeyRound } from 'lucide-react'
import { useTranslate, type Translate } from '@/i18n/use-translate'
import type {
  CloudSecretScope,
  CloudSecretsEffective
} from '../../../../../shared/cloud-secrets/cloud-secrets-wire'
import { Badge } from '../../ui/badge'
import { InlineError } from '../../ui/inline-error'
import { Skeleton } from '../../ui/skeleton'
import {
  cloudSecretKindLabel,
  cloudSecretScopeLabel,
  cloudSecretsErrorCopy
} from './cloud-secrets-copy'
import { maskedHint } from './CloudSecretList'
import type { Loadable } from './use-cloud-secrets'

const DEFAULT_PRECEDENCE: CloudSecretsEffective['precedence'] = {
  env: ['repo', 'personal', 'org'],
  agent_key: ['org', 'repo', 'personal']
}

function chain(scopes: readonly CloudSecretScope[], t: Translate): Record<string, string> {
  const [first = 'repo', second = 'personal', third = 'org'] = scopes
  return {
    first: cloudSecretScopeLabel(first, t),
    second: cloudSecretScopeLabel(second, t),
    third: cloudSecretScopeLabel(third, t)
  }
}

/** How a name set in several scopes resolves, one sentence per kind. */
export function CloudSecretsPrecedence({
  precedence = DEFAULT_PRECEDENCE
}: {
  precedence?: CloudSecretsEffective['precedence']
}): React.JSX.Element {
  const t = useTranslate()
  return (
    <ul className="space-y-1 rounded-md bg-muted/40 px-3 py-2.5 text-xs leading-5 text-muted-foreground">
      <li>
        {t(
          'cloudSecrets.precedence.envSentence',
          'Variables set in more than one place: {{first}} wins over {{second}}, which wins over {{third}}.',
          chain(precedence.env, t)
        )}
      </li>
      <li>
        {t(
          'cloudSecrets.precedence.agentSentence',
          'Agent keys: {{first}} wins over {{second}}, which wins over {{third}}, so a team key covers everyone.',
          chain(precedence.agent_key, t)
        )}
      </li>
    </ul>
  )
}

/** Every name a workspace would get, which scope supplies it, and what that hides. */
export function CloudSecretsEffectiveView({
  effective,
  onRetry
}: {
  effective: Loadable<CloudSecretsEffective>
  onRetry: () => void
}): React.JSX.Element {
  const t = useTranslate()
  if (effective.status === 'loading') {
    return (
      <div className="space-y-px rounded-md border border-border/60" aria-busy="true">
        {[0, 1].map((row) => (
          <div key={row} className="flex items-center gap-3 px-3 py-2.5">
            <Skeleton className="h-3 w-40" />
            <Skeleton className="ml-auto h-3 w-20" />
          </div>
        ))}
        <span className="sr-only">{t('cloudSecrets.list.loading', 'Loading secrets…')}</span>
      </div>
    )
  }
  if (effective.status === 'failed') {
    return (
      <InlineError
        title={cloudSecretsErrorCopy(effective.error, t)}
        retryLabel={t('cloudSecrets.list.retry', 'Try again')}
        onRetry={onRetry}
      />
    )
  }
  const { secrets, precedence } = effective.value
  return (
    <div className="space-y-3">
      <CloudSecretsPrecedence precedence={precedence} />
      {secrets.length === 0 ? (
        <div className="rounded-md border border-dashed border-border/60 px-4 py-5 text-center">
          <p className="text-sm font-medium">
            {t('cloudSecrets.effective.emptyTitle', 'Nothing is injected yet')}
          </p>
          <p className="mx-auto mt-1 max-w-md text-xs leading-5 text-muted-foreground">
            {t(
              'cloudSecrets.effective.emptyDetail',
              'Secrets you add in any scope show up here with the scope that wins.'
            )}
          </p>
        </div>
      ) : (
        <div className="overflow-hidden rounded-md border border-border/60">
          <table className="w-full table-fixed text-xs">
            <colgroup>
              <col />
              <col className="w-36" />
              <col className="w-44" />
            </colgroup>
            <thead className="sr-only">
              <tr>
                <th>{t('cloudSecrets.effective.name', 'Name')}</th>
                <th>{t('cloudSecrets.effective.winner', 'From')}</th>
                <th>{t('cloudSecrets.effective.shadowed', 'Overrides')}</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-border/60">
              {secrets.map((secret) => (
                <tr key={secret.name} className="align-middle">
                  <td className="px-3 py-2">
                    <span className="flex min-w-0 items-center gap-2">
                      <code className="truncate font-mono">{secret.name}</code>
                      {secret.kind === 'agent_key' ? (
                        <Badge variant="referenceLabel">
                          <KeyRound />
                          {cloudSecretKindLabel(secret.name, t)}
                        </Badge>
                      ) : null}
                    </span>
                  </td>
                  <td className="px-3 py-2">
                    <span className="flex items-center gap-2">
                      <Badge variant="outline">{cloudSecretScopeLabel(secret.scope, t)}</Badge>
                      <span className="font-mono text-muted-foreground">
                        {maskedHint(secret.hint)}
                      </span>
                    </span>
                  </td>
                  <td className="truncate px-3 py-2 text-muted-foreground">
                    {secret.shadowed.length > 0
                      ? t('cloudSecrets.effective.overrides', 'Overrides {{scopes}}', {
                          scopes: secret.shadowed
                            .map((entry) => cloudSecretScopeLabel(entry.scope, t))
                            .join(', ')
                        })
                      : null}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  )
}
