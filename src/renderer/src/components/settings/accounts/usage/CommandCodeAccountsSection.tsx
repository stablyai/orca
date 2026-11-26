import { useEffect, useRef, useState } from 'react'
import { toast } from 'sonner'
import { useIntlLocale, useTranslate, type Translate } from '@/i18n/use-translate'
import { useAppStore } from '../../../../store/index'
import type { CommandCodeCredentialsStatus } from '../../../../../../shared/agent-accounts/usage-credentials/command-code-credentials'
import type {
  ProviderRateLimits,
  RateLimitState
} from '../../../../../../shared/agent-usage/rate-limits/rate-limit-types'
import type { RuntimeClientTarget } from '../../../../../../shared/remote-runtime/host-catalog/runtime-client-target'
import {
  callCommandCodeCredentials,
  UsageCredentialsHostOutdatedError
} from '@/runtime/provider-accounts/usage/runtime-usage-credentials-client'
import { hasRuntimeRpcErrorCode } from '../../../../../../shared/remote-runtime/rpc/runtime-rpc-error-code'
import { Badge } from '../../../ui/badge'
import { Button } from '../../../ui/button'
import { Input } from '../../../ui/input'
import { Label } from '../../../ui/label'
import { SearchableSetting } from '../../section-layout/SearchableSetting'
import { SettingsGroup } from '../../section-layout/SettingsGroup'
import {
  usageCredentialAccessAfterError,
  usageCredentialAccessNotice,
  type UsageCredentialAccess,
  type UsageCredentialHost
} from './usage-credential-host'

type CredentialStatus = CommandCodeCredentialsStatus | null

const LOCAL_OWNER: RuntimeClientTarget = { kind: 'local' }

/** The selected remote host's streamed usage snapshot, as AccountsPane receives it. */
export type OwnerUsageSnapshot = {
  environmentId: string
  rateLimits: RateLimitState | null
} | null

/** Local scope shows this computer's poll; a remote host shows the reading streamed from that host. */
export function selectCommandCodeUsage(
  host: UsageCredentialHost,
  storeUsage: ProviderRateLimits | null,
  ownerUsage: OwnerUsageSnapshot
): ProviderRateLimits | null {
  if (host.label === null) {
    return storeUsage
  }
  const environmentId = host.owner.kind === 'environment' ? host.owner.environmentId : null
  return ownerUsage && environmentId !== null && ownerUsage.environmentId === environmentId
    ? (ownerUsage.rateLimits?.commandCode ?? null)
    : null
}

/** Remote hosts read and save the key on their own runtime; this device cannot see it. */
export function useCommandCodeCredentials(
  updatedAt: number | undefined,
  owner: RuntimeClientTarget
) {
  const t = useTranslate()
  const recordFeatureInteraction = useAppStore((s) => s.recordFeatureInteraction)
  const [status, setStatus] = useState<CredentialStatus>(null)
  const [access, setAccess] = useState<UsageCredentialAccess>(
    owner.kind === 'local' ? 'ready' : 'checking'
  )
  const [draft, setDraft] = useState('')
  const [busy, setBusy] = useState(false)
  const [retryNonce, setRetryNonce] = useState(0)
  const readGeneration = useRef(0)
  const mutationPending = useRef(false)
  const ownerEnvironmentId = owner.kind === 'environment' ? owner.environmentId : null

  useEffect(() => {
    if (mutationPending.current) {
      return
    }
    const request = ++readGeneration.current
    const readTarget: RuntimeClientTarget = ownerEnvironmentId
      ? { kind: 'environment', environmentId: ownerEnvironmentId }
      : LOCAL_OWNER
    void callCommandCodeCredentials(readTarget, 'getStatus').then(
      (next) => {
        if (request === readGeneration.current) {
          setStatus(next)
          setAccess('ready')
        }
      },
      (error: unknown) => {
        if (request === readGeneration.current) {
          setStatus(null)
          setAccess(ownerEnvironmentId ? usageCredentialAccessAfterError(error) : 'ready')
        }
      }
    )
    return () => {
      readGeneration.current += 1
    }
  }, [updatedAt, busy, ownerEnvironmentId, retryNonce])

  const retry = (): void => {
    if (busy) {
      return
    }
    setAccess('checking')
    setRetryNonce((nonce) => nonce + 1)
  }

  const runMutation = async (
    action: 'saveApiKey' | 'clearApiKey',
    value: string
  ): Promise<CommandCodeCredentialsStatus | Error> => {
    readGeneration.current += 1
    mutationPending.current = true
    setBusy(true)
    const result = await callCommandCodeCredentials(owner, action, value).then(
      (next): CommandCodeCredentialsStatus | Error =>
        typeof next?.apiKeyConfigured === 'boolean'
          ? next
          : new Error('Command Code keys can only be changed in the desktop app on this host.'),
      (error: unknown): Error => {
        if (error instanceof UsageCredentialsHostOutdatedError) {
          setAccess('outdated')
        }
        return error instanceof Error ? error : new Error(String(error))
      }
    )
    mutationPending.current = false
    setBusy(false)
    return result
  }

  const updateCredential = async (clear: boolean): Promise<void> => {
    if (mutationPending.current) {
      return
    }
    const result = await runMutation(clear ? 'clearApiKey' : 'saveApiKey', draft.trim())
    if (result instanceof Error) {
      const copy = mutationFailureCopy(clear, t, result)
      toast.error(copy.title, { description: copy.description })
      return
    }
    setStatus(result)
    setDraft('')
    recordFeatureInteraction('usage-tracking')
  }

  return { status, access, draft, setDraft, busy, updateCredential, retry }
}

function formatCredits(balance: number, locale: string): string {
  return new Intl.NumberFormat(locale, { maximumFractionDigits: 2 }).format(balance)
}

export function isClearTimeoutError(error: unknown): boolean {
  if (
    hasRuntimeRpcErrorCode(error, 'runtime_timeout') ||
    hasRuntimeRpcErrorCode(error, 'timeout')
  ) {
    return true
  }
  if (error instanceof Error) {
    if (/timeout/i.test(error.name)) {
      return true
    }
    if (/timed out/i.test(error.message)) {
      return true
    }
  }
  return false
}

export function mutationFailureCopy(
  clear: boolean,
  t: Translate,
  error?: unknown
): { title: string; description: string } {
  return clear
    ? {
        title: t(
          'auto.components.settings.AccountsPane.commandCode.clearFailed',
          'Could not clear the Command Code key'
        ),
        // The host may delete the key before a later step fails or a reply is lost, so no
        // clear failure can promise the key is unchanged.
        description: t(
          'auto.components.settings.AccountsPane.commandCode.clearFailedDescription',
          'Orca could not confirm the key was cleared. The status will refresh; check it before trying again.'
        )
      }
    : {
        title: t(
          'auto.components.settings.AccountsPane.commandCode.saveFailed',
          'Could not save the Command Code key'
        ),
        description:
          error instanceof Error && error.message.trim().length > 0
            ? error.message
            : t(
                'auto.components.settings.AccountsPane.commandCode.saveFailedDescription',
                'Check the key and try again.'
              )
      }
}

/** Saves one Command Code key on the selected host; switching accounts means replacing that key. */
export function CommandCodeAccountsSection({
  host,
  ownerUsage
}: {
  host: UsageCredentialHost
  /** The selected remote host's streamed usage snapshot; this computer's poll cannot describe it. */
  ownerUsage: OwnerUsageSnapshot
}): React.JSX.Element {
  const t = useTranslate()
  const intlLocale = useIntlLocale()
  const storeUsage = useAppStore((s) => s.rateLimits.commandCode)
  const usage = selectCommandCodeUsage(host, storeUsage, ownerUsage)
  const { status, access, draft, setDraft, busy, updateCredential, retry } =
    useCommandCodeCredentials(usage?.updatedAt, host.owner)
  const configured = status?.apiKeyConfigured === true
  const sessionPercent = usage?.session ? Math.round(usage.session.usedPercent) : null
  const weeklyPercent = usage?.weekly ? Math.round(usage.weekly.usedPercent) : null
  const balance = usage?.extraUsage?.unit === 'credits' ? usage.extraUsage.balance : null
  const accessNotice = usageCredentialAccessNotice(host, access, t)

  return (
    <SettingsGroup
      id="accounts-command-code"
      title={t('auto.components.settings.AccountsPane.commandCode.title', 'Command Code')}
    >
      <SearchableSetting
        title={t(
          'auto.components.settings.AccountsPane.commandCode.apiKey.title',
          'Command Code API key'
        )}
        description={t(
          'auto.components.settings.AccountsPane.commandCode.apiKey.description',
          'Save a Command Code API key to see plan usage and credits for it below.'
        )}
        keywords={['command code', 'commandcode', 'api', 'key', 'usage', 'rate limit', 'credits']}
        className="space-y-2 py-3"
      >
        <div className="flex items-center gap-2">
          <Label htmlFor="command-code-api-key">
            {t('auto.components.settings.AccountsPane.commandCode.apiKey.label', 'API key')}
          </Label>
          <Badge variant={configured ? 'secondary' : 'outline'}>
            {access === 'checking'
              ? t('auto.components.settings.AccountsPane.commandCode.checking', 'Checking…')
              : access === 'unreachable' || (access === 'ready' && status === null)
                ? t(
                    'auto.components.settings.AccountsPane.commandCode.unavailable',
                    'Status unavailable'
                  )
                : configured
                  ? t('auto.components.settings.AccountsPane.73ea15f24b', 'Saved')
                  : t('auto.components.settings.AccountsPane.23afe8f226', 'Not saved')}
          </Badge>
        </div>
        {accessNotice && <p className="text-xs text-muted-foreground">{accessNotice}</p>}
        <div className="flex gap-2">
          <Input
            id="command-code-api-key"
            type="password"
            value={draft}
            disabled={busy || access !== 'ready'}
            onChange={(event) => setDraft(event.target.value)}
            placeholder={t(
              'auto.components.settings.AccountsPane.commandCode.apiKey.placeholder',
              'Paste your Command Code API key'
            )}
            spellCheck={false}
            className="flex-1"
          />
          {access === 'unreachable' && (
            <Button size="xs" variant="outline" disabled={busy} onClick={retry}>
              {t('auto.components.settings.AccountsPane.commandCode.retry', 'Retry')}
            </Button>
          )}
          <Button
            size="xs"
            disabled={busy || access !== 'ready' || !draft.trim()}
            onClick={() => void updateCredential(false)}
          >
            {configured
              ? t('auto.components.settings.AccountsPane.f38b9cc4bd', 'Replace')
              : t('auto.components.settings.AccountsPane.590a3130f9', 'Save')}
          </Button>
          {configured && (
            <Button
              variant="ghost"
              size="xs"
              disabled={busy || access !== 'ready'}
              onClick={() => void updateCredential(true)}
            >
              {t('auto.components.settings.AccountsPane.b398b834c9', 'Clear')}
            </Button>
          )}
        </div>
      </SearchableSetting>
      {configured && usage && (
        <div className="space-y-1 py-3 text-sm text-muted-foreground">
          {usage.planType && (
            <p>
              {t('auto.components.settings.AccountsPane.commandCode.plan', 'Plan: {{plan}}', {
                plan: usage.planType
              })}
            </p>
          )}
          {sessionPercent !== null && (
            <p>
              {t(
                'auto.components.settings.AccountsPane.commandCode.session',
                '5-hour window: {{percent}}% used',
                { percent: sessionPercent }
              )}
            </p>
          )}
          {weeklyPercent !== null && (
            <p>
              {t(
                'auto.components.settings.AccountsPane.commandCode.weekly',
                'Weekly window: {{percent}}% used',
                { percent: weeklyPercent }
              )}
            </p>
          )}
          {balance !== null && (
            <p>
              {t(
                'auto.components.settings.AccountsPane.commandCode.credits',
                'Credits remaining: {{credits}}',
                { credits: formatCredits(balance, intlLocale) }
              )}
            </p>
          )}
          {usage.error && <p className="text-destructive">{usage.error}</p>}
        </div>
      )}
    </SettingsGroup>
  )
}

export const isTimeoutError = isClearTimeoutError
export const isClearTimeout = isClearTimeoutError

export function renderCommandCodeAccountsSection(
  ownerKey: string,
  host: UsageCredentialHost,
  ownerUsage: OwnerUsageSnapshot
): React.JSX.Element {
  return (
    <CommandCodeAccountsSection
      key={`command-code:${ownerKey}`}
      host={host}
      ownerUsage={ownerUsage}
    />
  )
}
