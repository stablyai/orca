import { useState } from 'react'
import { isWebClientLocation } from '@/lib/web-client-location'
import { ExternalLink, Loader2, Lock, LockOpen, RefreshCw, ShieldCheck } from 'lucide-react'
import { translate } from '@/i18n/i18n'
import { cn } from '@/lib/utils'
import { useAppStore } from '../../store'
import { Badge } from '../ui/badge'
import { Button } from '../ui/button'
import { Input } from '../ui/input'
import { Label } from '../ui/label'
import { SearchableSetting } from './section-layout/SearchableSetting'
import {
  usageCredentialAccessNotice,
  usageCredentialSealedElsewhere,
  usageCredentialUnreadableNotice,
  ollamaCloudKeyDescription,
  type UsageCredentialHost
} from './usage-credential-host'
import { useOllamaCloudCredentials } from './use-ollama-cloud-credentials'
import { UnsealedCredentialNotice } from './UnsealedCredentialNotice'

const SEARCH_KEYWORDS = ['ollama', 'cloud', 'usage', 'credits', 'rate limit']

/** Currency-only balance; Ollama has no session/weekly percent windows on modern plans. */
function formatUsd(amount: number | null): string | null {
  if (amount === null) {
    return null
  }
  return `$${amount.toFixed(2)}`
}

export function OllamaCloudAccountsSection({
  host
}: {
  host: UsageCredentialHost
}): React.JSX.Element {
  const refreshRateLimits = useAppStore((s) => s.refreshRateLimits)
  const storeOllamaUsage = useAppStore((s) => s.rateLimits.ollama)
  const hostLabel = host.label
  // This computer's usage poll cannot describe another host's subscription.
  const ollamaUsage = hostLabel === null ? storeOllamaUsage : null
  const { status, access, apiKeyDraft, setApiKeyDraft, credentialBusy, saveApiKey, clearApiKey } =
    useOllamaCloudCredentials(ollamaUsage?.updatedAt, host.owner)
  const [refreshing, setRefreshing] = useState(false)

  const webClient = isWebClientLocation()
  const credentialEditable = !webClient && access === 'ready'
  const accessNotice = usageCredentialAccessNotice(host, access)
  const unreadableNotice = usageCredentialUnreadableNotice(host, status?.apiKeyUnreadable)
  const keyEditable =
    credentialEditable && !usageCredentialSealedElsewhere(host, status?.apiKeyUnreadable)
  const detailsUnavailable = webClient || status?.detailsUnavailable === true
  const apiKeyConfigured = status?.apiKeyConfigured === true

  const handleRefreshUsage = async (): Promise<void> => {
    setRefreshing(true)
    try {
      await refreshRateLimits()
    } finally {
      setRefreshing(false)
    }
  }

  const usage = ollamaUsage ?? null
  const balance = usage?.extraUsage ?? null
  const currencyBalance = balance?.unit === 'currency' ? balance : null
  const balanceText = formatUsd(currencyBalance?.balance ?? null)
  const spendLimitText = formatUsd(currencyBalance?.spendLimit ?? null)
  const totals = usage?.ollamaUsageTotals ?? null

  return (
    <section id="accounts-ollama" className="space-y-4 scroll-mt-6">
      <div className="flex items-start justify-between gap-3">
        <div className="space-y-1">
          <h3 className="flex items-center gap-2 text-sm font-semibold">
            {translate('auto.components.settings.OllamaCloudAccountsSection.title', 'Ollama Cloud')}
          </h3>
          <p className="text-xs text-muted-foreground">
            {translate(
              'auto.components.settings.OllamaCloudAccountsSection.subtitle',
              'Track Ollama cloud subscription usage in the status bar. Save the API key from ollama.com here.'
            )}
          </p>
        </div>
        <a
          href="https://ollama.com/settings/keys"
          target="_blank"
          rel="noopener noreferrer"
          className="inline-flex items-center gap-1 text-xs text-muted-foreground hover:text-foreground"
        >
          {translate(
            'auto.components.settings.OllamaCloudAccountsSection.consoleLink',
            'Get API key'
          )}
          <ExternalLink className="size-3" />
        </a>
      </div>

      <div
        className={cn(
          'flex items-start gap-3 rounded-lg border bg-muted/20 p-3',
          apiKeyConfigured ? 'border-border/60' : 'border-border/40'
        )}
      >
        <ShieldCheck
          className={cn(
            'mt-0.5 size-4 shrink-0',
            apiKeyConfigured ? 'text-foreground' : 'text-muted-foreground'
          )}
        />
        <div className="min-w-0 flex-1 space-y-0.5">
          {accessNotice ? (
            <p className="text-xs font-medium">{accessNotice}</p>
          ) : detailsUnavailable ? (
            <p className="text-xs text-muted-foreground">
              {translate(
                'auto.components.settings.OllamaCloudAccountsSection.detailsUnavailable',
                'Credential details are only readable on the computer running Orca.'
              )}
            </p>
          ) : apiKeyConfigured ? (
            <>
              <p className="text-xs font-medium">
                {translate(
                  'auto.components.settings.OllamaCloudAccountsSection.keyStored',
                  'API key saved'
                )}
              </p>
              <p className="text-xs text-muted-foreground">
                {hostLabel === null
                  ? translate(
                      'auto.components.settings.OllamaCloudAccountsSection.keyStoredHelp',
                      'Stored locally and sent only to ollama.com for usage refreshes.'
                    )
                  : translate(
                      'auto.components.settings.OllamaCloudAccountsSection.keyStoredOnHostHelp',
                      'Stored on {{host}} and sent from there only to ollama.com for usage refreshes.',
                      { host: hostLabel }
                    )}
              </p>
            </>
          ) : (
            <>
              <p className="text-xs font-medium">
                {translate(
                  'auto.components.settings.OllamaCloudAccountsSection.notConfigured',
                  'No Ollama cloud subscription linked'
                )}
              </p>
              <p className="text-xs text-muted-foreground">
                {hostLabel === null
                  ? translate(
                      'auto.components.settings.OllamaCloudAccountsSection.notConfiguredHelp',
                      'Save the API key from ollama.com below.'
                    )
                  : translate(
                      'auto.components.settings.OllamaCloudAccountsSection.notConfiguredOnHostHelp',
                      'Save the API key from ollama.com below in the desktop app on {{host}}.',
                      { host: hostLabel }
                    )}
              </p>
            </>
          )}
          {usage?.status === 'error' && usage.error ? (
            <p className="text-xs text-destructive">{usage.error}</p>
          ) : null}
        </div>
        {hostLabel === null ? (
          <Button
            variant="outline"
            size="xs"
            disabled={refreshing}
            onClick={() => void handleRefreshUsage()}
            className="shrink-0"
          >
            {refreshing ? (
              <Loader2 className="size-3 animate-spin" />
            ) : (
              <RefreshCw className="size-3" />
            )}
            {translate(
              'auto.components.settings.OllamaCloudAccountsSection.refreshUsage',
              'Refresh usage'
            )}
          </Button>
        ) : null}
      </div>

      {webClient ? (
        <p className="text-xs text-muted-foreground">
          {translate(
            'auto.components.settings.OllamaCloudAccountsSection.hostOnly',
            'Change the API key in the desktop app on the computer running Orca.'
          )}
        </p>
      ) : null}

      <SearchableSetting
        title={translate('auto.components.settings.OllamaCloudAccountsSection.keyTitle', 'API key')}
        description={ollamaCloudKeyDescription(host)}
        keywords={SEARCH_KEYWORDS}
        className="space-y-2"
      >
        <div className="flex items-center justify-between gap-2">
          <div className="flex items-center gap-2">
            <Label htmlFor="ollama-cloud-api-key">
              {translate('auto.components.settings.OllamaCloudAccountsSection.keyTitle', 'API key')}
            </Label>
            {!detailsUnavailable ? (
              <Badge variant={apiKeyConfigured ? 'secondary' : 'outline'}>
                {apiKeyConfigured ? <Lock className="size-3" /> : <LockOpen className="size-3" />}
                {apiKeyConfigured
                  ? translate('auto.components.settings.OllamaCloudAccountsSection.saved', 'Saved')
                  : translate(
                      'auto.components.settings.OllamaCloudAccountsSection.notSaved',
                      'Not saved'
                    )}
              </Badge>
            ) : null}
          </div>
        </div>
        <UnsealedCredentialNotice
          protection={status?.apiKeyProtection ?? null}
          credentialName={translate(
            'auto.components.settings.OllamaCloudAccountsSection.title',
            'Ollama Cloud'
          )}
        />
        {unreadableNotice ? (
          <p className="text-xs text-muted-foreground">{unreadableNotice}</p>
        ) : null}
        <div className="flex gap-2">
          <Input
            id="ollama-cloud-api-key"
            type="password"
            disabled={credentialBusy || !keyEditable}
            value={apiKeyDraft}
            onChange={(e) => setApiKeyDraft(e.target.value)}
            placeholder={translate(
              'auto.components.settings.OllamaCloudAccountsSection.keyPlaceholder',
              'Paste your Ollama API key'
            )}
            spellCheck={false}
            className="flex-1"
          />
          <Button
            size="xs"
            onClick={() => void saveApiKey()}
            disabled={credentialBusy || !keyEditable || !apiKeyDraft.trim()}
            className="shrink-0"
          >
            {credentialBusy ? <Loader2 className="size-3 animate-spin" /> : null}
            {apiKeyConfigured
              ? translate('auto.components.settings.OllamaCloudAccountsSection.replace', 'Replace')
              : translate('auto.components.settings.OllamaCloudAccountsSection.save', 'Save')}
          </Button>
          {apiKeyConfigured ? (
            <Button
              variant="ghost"
              size="xs"
              onClick={() => void clearApiKey()}
              disabled={credentialBusy || !credentialEditable}
              className="shrink-0"
            >
              {translate(
                'auto.components.settings.OllamaCloudAccountsSection.forgetKey',
                'Forget key'
              )}
            </Button>
          ) : null}
        </div>
        <p className="text-xs text-muted-foreground">
          {translate(
            'auto.components.settings.OllamaCloudAccountsSection.keyHelp',
            'The same OLLAMA_API_KEY your launch tools use (ollama launch claude, codex, droid…). Sent only to ollama.com for usage checks.'
          )}
        </p>
      </SearchableSetting>

      {balance ? (
        <SearchableSetting
          title={translate(
            'auto.components.settings.OllamaCloudAccountsSection.usageTitle',
            'Subscription usage'
          )}
          description={translate(
            'auto.components.settings.OllamaCloudAccountsSection.usageDescription',
            'Remaining credits and 30-day spend for the linked subscription, refreshed with the status bar usage cycle.'
          )}
          keywords={SEARCH_KEYWORDS}
        >
          <div className="space-y-1 text-xs">
            {balanceText !== null ? (
              <p>
                {spendLimitText !== null
                  ? translate(
                      'auto.components.settings.OllamaCloudAccountsSection.includedWithLimit',
                      'Included credits: {{value0}} of {{value1}}',
                      { value0: balanceText, value1: spendLimitText }
                    )
                  : translate(
                      'auto.components.settings.OllamaCloudAccountsSection.included',
                      'Included credits: {{value0}}',
                      {
                        value0: balanceText
                      }
                    )}
              </p>
            ) : null}
            {totals?.spentUsd != null ? (
              <p className="text-muted-foreground">
                {translate(
                  'auto.components.settings.OllamaCloudAccountsSection.monthSpend',
                  '30-day cloud spend: ${{value0}} across {{value1}} requests',
                  {
                    value0: totals.spentUsd.toFixed(2),
                    value1: totals.requestCount ?? 0
                  }
                )}
              </p>
            ) : null}
            {totals?.purchasedBalanceUsd != null ? (
              <p className="text-muted-foreground">
                {translate(
                  'auto.components.settings.OllamaCloudAccountsSection.purchasedCredits',
                  'Purchased credits: ${{value0}}',
                  { value0: totals.purchasedBalanceUsd.toFixed(2) }
                )}
              </p>
            ) : null}
            {totals?.inputTokens != null ? (
              <p className="text-muted-foreground">
                {translate(
                  'auto.components.settings.OllamaCloudAccountsSection.monthTokens',
                  '30-day tokens: {{value0}} in · {{value1}} cached · {{value2}} out',
                  {
                    value0: totals.inputTokens.toLocaleString(),
                    value1: (totals.cachedInputTokens ?? 0).toLocaleString(),
                    value2: (totals.outputTokens ?? 0).toLocaleString()
                  }
                )}
              </p>
            ) : null}
            {usage?.planType ? (
              <p className="text-muted-foreground">
                {translate(
                  'auto.components.settings.OllamaCloudAccountsSection.planLevel',
                  'Plan: {{value0}}',
                  {
                    value0: usage.planType
                  }
                )}
              </p>
            ) : null}
          </div>
        </SearchableSetting>
      ) : null}
    </section>
  )
}
