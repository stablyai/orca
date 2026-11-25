import { useEffect, useRef, useState } from 'react'
import { toast } from 'sonner'
import { useIntlLocale, useTranslate, type Translate } from '@/i18n/use-translate'
import { useAppStore } from '../../../../store/index'
import type { CommandCodeCredentialsStatus } from '../../../../../../shared/agent-accounts/usage-credentials/command-code-credentials'
import type { RuntimeClientTarget } from '../../../../../../shared/remote-runtime/host-catalog/runtime-client-target'
import {
  callCommandCodeCredentials,
  UsageCredentialsHostOutdatedError
} from '@/runtime/provider-accounts/usage/runtime-usage-credentials-client'
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

/** Remote hosts read and save the key on their own runtime; this device cannot see it. */
function useCommandCodeCredentials(updatedAt: number | undefined, owner: RuntimeClientTarget) {
  const t = useTranslate()
  const recordFeatureInteraction = useAppStore((s) => s.recordFeatureInteraction)
  const [status, setStatus] = useState<CredentialStatus>(null)
  const [access, setAccess] = useState<UsageCredentialAccess>(
    owner.kind === 'local' ? 'ready' : 'checking'
  )
  const [draft, setDraft] = useState('')
  const [busy, setBusy] = useState(false)
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
  }, [updatedAt, busy, ownerEnvironmentId])

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
      const copy = mutationFailureCopy(clear, t)
      toast.error(copy.title, { description: copy.description })
      return
    }
    setStatus(result)
    setDraft('')
    recordFeatureInteraction('usage-tracking')
  }

  return { status, access, draft, setDraft, busy, updateCredential }
}

function formatCredits(balance: number, locale: string): string {
  return new Intl.NumberFormat(locale, { maximumFractionDigits: 2 }).format(balance)
}

function mutationFailureCopy(clear: boolean, t: Translate): { title: string; description: string } {
  return clear
    ? {
        title: t(
          'auto.components.settings.AccountsPane.commandCode.clearFailed',
          'Could not clear the Command Code key'
        ),
        description: t(
          'auto.components.settings.AccountsPane.commandCode.clearFailedDescription',
          'The saved key is unchanged. Try again.'
        )
      }
    : {
        title: t(
          'auto.components.settings.AccountsPane.commandCode.saveFailed',
          'Could not save the Command Code key'
        ),
        description: t(
          'auto.components.settings.AccountsPane.commandCode.saveFailedDescription',
          'Check the key and try again.'
        )
      }
}

/** Saves one Command Code key on the selected host; switching accounts means replacing that key. */
export function CommandCodeAccountsSection({
  host
}: {
  host: UsageCredentialHost
}): React.JSX.Element {
  const t = useTranslate()
  const intlLocale = useIntlLocale()
  const storeUsage = useAppStore((s) => s.rateLimits.commandCode)
  // This computer's usage poll cannot describe another host's key.
  const usage = host.label === null ? storeUsage : null
  const { status, access, draft, setDraft, busy, updateCredential } = useCommandCodeCredentials(
    usage?.updatedAt,
    host.owner
  )
  const configured = status?.apiKeyConfigured === true
  const monthlyPercent = usage?.monthly ? Math.round(usage.monthly.usedPercent) : null
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
          {monthlyPercent !== null && (
            <p>
              {t(
                'auto.components.settings.AccountsPane.commandCode.monthly',
                'Monthly plan: {{percent}}% used',
                { percent: monthlyPercent }
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

export function renderCommandCodeAccountsSection(
  ownerKey: string,
  host: UsageCredentialHost
): React.JSX.Element {
  return <CommandCodeAccountsSection key={`command-code:${ownerKey}`} host={host} />
}
