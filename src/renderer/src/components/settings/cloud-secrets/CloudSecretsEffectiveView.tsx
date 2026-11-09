import { ChevronRight, KeyRound, RefreshCw } from 'lucide-react'
import { Fragment } from 'react'
import { useTranslate, type Translate } from '@/i18n/use-translate'
import type {
  CloudSecretScope,
  CloudSecretsEffective
} from '../../../../../shared/cloud-secrets/cloud-secrets-wire'
import { Badge } from '../../ui/badge'
import { Button } from '../../ui/button'
import { cloudSecretScopeLabel, cloudSecretsErrorCopy } from './cloud-secrets-copy'
import { maskedHint } from './CloudSecretList'
import type { Loadable } from './use-cloud-secrets'

const DEFAULT_PRECEDENCE: CloudSecretsEffective['precedence'] = {
  env: ['repo', 'personal', 'org'],
  agent_key: ['org', 'repo', 'personal']
}

function Order({
  scopes,
  t
}: {
  scopes: readonly CloudSecretScope[]
  t: Translate
}): React.JSX.Element {
  return (
    <span className="inline-flex flex-wrap items-center gap-1">
      {scopes.map((scope, index) => (
        <Fragment key={scope}>
          {index > 0 ? <ChevronRight aria-hidden className="size-3 text-muted-foreground" /> : null}
          <Badge variant="outline">{cloudSecretScopeLabel(scope, t)}</Badge>
        </Fragment>
      ))}
    </span>
  )
}

/** How a name set in several scopes resolves; first scope listed wins. */
export function CloudSecretsPrecedence({
  precedence = DEFAULT_PRECEDENCE
}: {
  precedence?: CloudSecretsEffective['precedence']
}): React.JSX.Element {
  const t = useTranslate()
  return (
    <div className="space-y-2 rounded-md bg-muted/40 px-3 py-2.5 text-xs">
      <div className="grid grid-cols-[7.5rem_minmax(0,1fr)] items-center gap-x-3 gap-y-2">
        <span className="text-muted-foreground">
          {t('cloudSecrets.precedence.env', 'Environment')}
        </span>
        <Order scopes={precedence.env} t={t} />
        <span className="text-muted-foreground">
          {t('cloudSecrets.precedence.agentKeys', 'Agent keys')}
        </span>
        <Order scopes={precedence.agent_key} t={t} />
      </div>
      <p className="leading-5 text-muted-foreground">
        {t(
          'cloudSecrets.precedence.detail',
          'When a name is set in more than one place, the leftmost wins. Team agent keys come first so everyone on the team runs on the same account.'
        )}
      </p>
    </div>
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
            <div className="h-3 w-40 rounded bg-muted motion-safe:animate-pulse" />
            <div className="ml-auto h-3 w-20 rounded bg-muted motion-safe:animate-pulse" />
          </div>
        ))}
        <span className="sr-only">{t('cloudSecrets.list.loading', 'Loading secrets…')}</span>
      </div>
    )
  }
  if (effective.status === 'failed') {
    return (
      <div className="flex items-center justify-between gap-3 rounded-md border border-border/60 px-3 py-3">
        <p role="alert" className="text-xs text-muted-foreground">
          {cloudSecretsErrorCopy(effective.error, t)}
        </p>
        <Button variant="outline" size="xs" onClick={onRetry}>
          <RefreshCw />
          {t('cloudSecrets.list.retry', 'Try again')}
        </Button>
      </div>
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
            <thead className="sr-only">
              <tr>
                <th>{t('cloudSecrets.effective.name', 'Name')}</th>
                <th>{t('cloudSecrets.effective.winner', 'Used from')}</th>
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
                        <KeyRound
                          aria-label={t('cloudSecrets.list.agentKey', 'Agent key')}
                          className="size-3 shrink-0 text-muted-foreground"
                        />
                      ) : null}
                    </span>
                  </td>
                  <td className="w-40 px-3 py-2">
                    <span className="flex items-center gap-2">
                      <Badge variant="outline">{cloudSecretScopeLabel(secret.scope, t)}</Badge>
                      <span className="font-mono text-muted-foreground">
                        {maskedHint(secret.hint)}
                      </span>
                    </span>
                  </td>
                  <td className="w-56 truncate px-3 py-2 text-muted-foreground">
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
