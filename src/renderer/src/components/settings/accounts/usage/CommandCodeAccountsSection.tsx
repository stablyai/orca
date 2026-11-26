import { toast } from 'sonner'
import { useIntlLocale, useTranslate, type Translate } from '@/i18n/use-translate'
import { useAppStore } from '../../../../store/index'
import type { CommandCodeCredentialsStatus } from '../../../../../../shared/agent-accounts/usage-credentials/command-code-credentials'
import type {
  ProviderRateLimits,
  RateLimitState
} from '../../../../../../shared/agent-usage/rate-limits/rate-limit-types'
import type { RuntimeClientTarget } from '../../../../../../shared/remote-runtime/host-catalog/runtime-client-target'
import { callCommandCodeCredentials } from '@/runtime/provider-accounts/usage/runtime-usage-credentials-client'
import { SearchableSetting } from '../../section-layout/SearchableSetting'
import { SettingsGroup } from '../../section-layout/SettingsGroup'
import { usageCredentialAccessNotice, type UsageCredentialHost } from './usage-credential-host'
import { UsageApiKeyField } from './UsageApiKeyField'
import { useUsageApiKeyCredentials } from './use-usage-api-key-credentials'

function isCommandCodeStatus(
  next: CommandCodeCredentialsStatus | null | undefined
): next is CommandCodeCredentialsStatus {
  return typeof next?.apiKeyConfigured === 'boolean'
}

/** The selected remote host's streamed usage snapshot, as AccountsPane receives it. */
export type OwnerUsageSnapshot = {
  environmentId: string
  rateLimits: RateLimitState | null
} | null

/** Local scope shows this computer's poll; a remote host shows the reading streamed from that host. */
function selectCommandCodeUsage(
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
function useCommandCodeCredentials(updatedAt: number | undefined, owner: RuntimeClientTarget) {
  const t = useTranslate()
  return useUsageApiKeyCredentials({
    owner,
    updatedAt,
    call: callCommandCodeCredentials,
    isStatus: isCommandCodeStatus,
    hostCannotStoreMessage:
      'Command Code keys can only be changed in the desktop app on this host.',
    onMutationFailed: (action, error) => {
      const copy = mutationFailureCopy(action === 'clearApiKey', t, error)
      toast.error(copy.title, { description: copy.description })
    }
  })
}

function formatCredits(balance: number, locale: string): string {
  return new Intl.NumberFormat(locale, { maximumFractionDigits: 2 }).format(balance)
}

function mutationFailureCopy(
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
  const { status, access, draft, setDraft, busy, saveApiKey, clearApiKey, retry } =
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
        <UsageApiKeyField
          inputId="command-code-api-key"
          label={t('auto.components.settings.AccountsPane.commandCode.apiKey.label', 'API key')}
          placeholder={t(
            'auto.components.settings.AccountsPane.commandCode.apiKey.placeholder',
            'Paste your Command Code API key'
          )}
          badgeLabel={
            access === 'checking'
              ? t('auto.components.settings.AccountsPane.commandCode.checking', 'Checking…')
              : access === 'unreachable' || (access === 'ready' && status === null)
                ? t(
                    'auto.components.settings.AccountsPane.commandCode.unavailable',
                    'Status unavailable'
                  )
                : configured
                  ? t('auto.components.settings.AccountsPane.73ea15f24b', 'Saved')
                  : t('auto.components.settings.AccountsPane.23afe8f226', 'Not saved')
          }
          configured={configured}
          draft={draft}
          onDraftChange={setDraft}
          disabled={busy || access !== 'ready'}
          onSave={() => void saveApiKey()}
          onClear={() => void clearApiKey()}
          notice={accessNotice}
          retry={
            access === 'unreachable'
              ? {
                  label: t('auto.components.settings.AccountsPane.commandCode.retry', 'Retry'),
                  disabled: busy,
                  onClick: retry
                }
              : null
          }
        />
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

// AccountsPane is at its line cap, so it renders this section through a keyed factory.
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
