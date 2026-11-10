import { useState } from 'react'
import { Check, KeyRound, Loader2 } from 'lucide-react'
import { useTranslate } from '@/i18n/use-translate'
import { formatAgentTypeLabel } from '../../../../shared/agent-status/presentation/agent-type-label'
import type { CloudSecretsErrorCode } from '../../../../shared/cloud-secrets/cloud-secrets-wire'
import { Button } from '../ui/button'
import { InlineError } from '../ui/inline-error'
import { cloudSecretsErrorCopy } from '../settings/cloud-secrets/cloud-secrets-copy'
import type { CloudOfferableDesktopKey } from './cloud-agent-readiness'

type RowState =
  | { kind: 'idle' }
  | { kind: 'saving' }
  | { kind: 'saved' }
  | { kind: 'failed'; error: CloudSecretsErrorCode }

/**
 * This computer's Agent API keys are never sent to a cloud workspace (DS-02). Each one can be saved
 * to the user's Orca account (a personal Cloud secret) with its own click; the workspace then only
 * holds a stand-in that the network swaps.
 */
export function CloudDesktopKeysOffer({
  keys,
  onSave
}: {
  keys: readonly CloudOfferableDesktopKey[]
  onSave: (key: CloudOfferableDesktopKey) => Promise<CloudSecretsErrorCode | null>
}): React.JSX.Element | null {
  const t = useTranslate()
  const [states, setStates] = useState<Record<string, RowState>>({})
  if (keys.length === 0) {
    return null
  }
  const save = async (key: CloudOfferableDesktopKey): Promise<void> => {
    if (states[key.id]?.kind === 'saving') {
      return
    }
    setStates((current) => ({ ...current, [key.id]: { kind: 'saving' } }))
    const error = await onSave(key)
    setStates((current) => ({
      ...current,
      [key.id]: error ? { kind: 'failed', error } : { kind: 'saved' }
    }))
  }
  return (
    <section
      className="space-y-2 rounded-md border border-border px-3 py-2"
      aria-labelledby="cloud-desktop-keys-title"
    >
      <p id="cloud-desktop-keys-title" className="text-xs font-medium">
        {t('cloudAgentSetup.desktopKeys.title', 'Keys on this computer')}
      </p>
      <p className="text-xs text-muted-foreground">
        {t(
          'cloudAgentSetup.desktopKeys.detail',
          'Save it to your Orca account to use it in cloud workspaces. It stays outside the sandbox.'
        )}
      </p>
      <ul className="space-y-2">
        {keys.map((key) => {
          const state = states[key.id] ?? { kind: 'idle' }
          return (
            <li key={key.id} className="space-y-1">
              <div className="flex items-center gap-2 text-xs">
                <KeyRound aria-hidden className="size-3.5 shrink-0 text-muted-foreground" />
                <span className="min-w-0 flex-1">
                  <span className="block">
                    {state.kind === 'saved'
                      ? t(
                          'cloudAgentSetup.desktopKeys.rowSaved',
                          '{{agent}}: your API key ••••{{hint}}',
                          {
                            agent: formatAgentTypeLabel(key.agent),
                            hint: key.hint
                          }
                        )
                      : t(
                          'cloudAgentSetup.desktopKeys.row',
                          '{{agent}}: your API key ••••{{hint}} is only on this computer',
                          { agent: formatAgentTypeLabel(key.agent), hint: key.hint }
                        )}
                  </span>
                  <code className="block font-mono text-muted-foreground">{key.envName}</code>
                </span>
                {state.kind === 'saved' ? (
                  <span role="status" className="inline-flex shrink-0 items-center gap-1">
                    <Check aria-hidden className="size-3.5" />
                    {t('cloudAgentSetup.desktopKeys.saved', 'Saved to your Orca account')}
                  </span>
                ) : state.kind === 'failed' ? null : (
                  <Button
                    type="button"
                    variant="outline"
                    size="xs"
                    className="shrink-0"
                    aria-disabled={state.kind === 'saving' || undefined}
                    aria-busy={state.kind === 'saving' || undefined}
                    aria-label={t(
                      'cloudAgentSetup.desktopKeys.saveLabel',
                      'Save {{name}} to your Orca account',
                      { name: key.envName }
                    )}
                    onClick={() => void save(key)}
                  >
                    {state.kind === 'saving' ? <Loader2 className="animate-spin" /> : null}
                    {t('cloudAgentSetup.desktopKeys.save', 'Save to your Orca account')}
                  </Button>
                )}
              </div>
              {state.kind === 'failed' ? (
                <InlineError
                  density="compact"
                  title={t(
                    'cloudAgentSetup.desktopKeys.failed',
                    'Couldn’t save {{name}}. Nothing was changed.',
                    { name: key.envName }
                  )}
                  detail={
                    state.error === 'not_swappable'
                      ? cloudSecretsErrorCopy(state.error, t)
                      : undefined
                  }
                  retryLabel={t('cloudAgentSetup.desktopKeys.retry', 'Try again')}
                  onRetry={() => void save(key)}
                />
              ) : null}
            </li>
          )
        })}
      </ul>
    </section>
  )
}
