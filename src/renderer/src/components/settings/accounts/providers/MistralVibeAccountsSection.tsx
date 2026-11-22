import { useState } from 'react'
import { ExternalLink, Loader2, RefreshCw, ShieldCheck } from 'lucide-react'
import { AgentIcon } from '@/components/agent/icons/AgentIcon'
import { useTranslate } from '@/i18n/use-translate'
import { cn } from '@/lib/class-names'
import { useAppStore } from '../../../../store/index'
import { Badge } from '../../../ui/badge'
import { Button } from '../../../ui/button'
import { SearchableSetting } from '../../section-layout/SearchableSetting'
import { openAppHttpLinkFromAnchor } from '@/lib/browser/navigation/app-http-link-open'
import { SettingsGroup } from '../../section-layout/SettingsGroup'
import { matchesSettingsSearch } from '../../search/settings-search'
import {
  getAccountsMistralVibeSearchEntries,
  MISTRAL_VIBE_ACCOUNTS_SECTION_ID
} from './mistral-vibe-accounts-search'

const VIBE_DOCS_URL = 'https://github.com/mistralai/mistral-vibe'

type Translate = ReturnType<typeof useTranslate>

function credentialSourceLabel(source: string | undefined, t: Translate): string | null {
  switch (source) {
    case 'env':
      return t('accounts.mistralVibe.source.env', 'API key from MISTRAL_API_KEY')
    case 'dotenv':
      return t('accounts.mistralVibe.source.dotenv', 'API key from ~/.vibe/.env')
    case 'keyring':
      return t('accounts.mistralVibe.source.keyring', 'API key saved by Vibe in the system keyring')
    case 'oidc':
      return t('accounts.mistralVibe.source.oidc', 'Vibe browser sign-in')
    case undefined:
    default:
      return null
  }
}

/** Status derives from the usage reading itself; the credential never leaves main. */
export function MistralVibeAccountsSection(): React.JSX.Element {
  const t = useTranslate()
  const refreshRateLimits = useAppStore((s) => s.refreshRateLimits)
  const usage = useAppStore((s) => s.rateLimits.mistralVibe)
  const [refreshing, setRefreshing] = useState(false)

  const handleRefreshUsage = (): void => {
    setRefreshing(true)
    void refreshRateLimits().finally(() => setRefreshing(false))
  }

  const failureKind = usage?.usageMetadata?.failureKind
  const loading = usage == null || (usage.status === 'fetching' && !usage.monthly)
  const signedIn = !loading && failureKind !== 'missing-credentials'
  const healthy = signedIn && usage?.status === 'ok'
  const source = credentialSourceLabel(usage?.usageMetadata?.credentialSource, t)
  const monthly = usage?.monthly ?? null

  return (
    <div id={MISTRAL_VIBE_ACCOUNTS_SECTION_ID} className="scroll-mt-6">
      <SettingsGroup
        title={
          <span className="flex items-center gap-2">
            <AgentIcon agent="mistral-vibe" size={16} />
            {t('accounts.mistralVibe.title', 'Mistral Vibe')}
          </span>
        }
        description={t(
          'accounts.mistralVibe.description',
          'Shows your monthly Vibe Code budget using the same sign-in as the vibe CLI.'
        )}
        action={
          <a
            href={VIBE_DOCS_URL}
            target="_blank"
            onClick={openAppHttpLinkFromAnchor}
            rel="noopener noreferrer"
            className="inline-flex items-center gap-1 text-xs text-muted-foreground hover:text-foreground"
          >
            {t('accounts.mistralVibe.docs', 'Vibe CLI docs')}
            <ExternalLink className="size-3" />
          </a>
        }
      >
        <div className="flex items-start gap-3 py-3">
          <ShieldCheck
            className={cn(
              'mt-0.5 size-4 shrink-0',
              healthy ? 'text-foreground' : 'text-muted-foreground'
            )}
          />
          <div className="min-w-0 flex-1 space-y-1">
            {loading ? (
              <p className="text-xs text-muted-foreground">
                {t('accounts.mistralVibe.loading', 'Loading…')}
              </p>
            ) : signedIn ? (
              <>
                <p className="truncate text-xs font-medium">
                  {t('accounts.mistralVibe.signedIn', 'Signed in')}
                </p>
                {source ? <p className="text-xs text-muted-foreground">{source}</p> : null}
              </>
            ) : (
              <>
                <p className="text-xs font-medium">
                  {t('accounts.mistralVibe.notSignedIn', 'Not signed in to Mistral Vibe')}
                </p>
                <p className="text-xs text-muted-foreground">
                  {t(
                    'accounts.mistralVibe.signInHint',
                    'In a terminal, run vibe and sign in (or set MISTRAL_API_KEY), then click Refresh usage here.'
                  )}
                </p>
              </>
            )}
            {signedIn && usage?.status !== 'ok' && usage?.error ? (
              <p className="text-xs text-destructive">{usage.error}</p>
            ) : null}
          </div>
          <Button
            variant="outline"
            size="xs"
            disabled={refreshing}
            onClick={handleRefreshUsage}
            className="shrink-0"
          >
            {refreshing ? (
              <Loader2 className="size-3 animate-spin" />
            ) : (
              <RefreshCw className="size-3" />
            )}
            {t('accounts.mistralVibe.refresh', 'Refresh usage')}
          </Button>
        </div>

        {monthly ? (
          <SearchableSetting
            title={t('accounts.mistralVibe.monthlyTitle', 'Monthly budget')}
            description={t(
              'accounts.mistralVibe.monthlyDescription',
              'Same Vibe Code usage % as the usage gauge in the vibe footer.'
            )}
            keywords={['mistral', 'vibe', 'usage', 'budget']}
            className="py-3"
          >
            <div className="flex items-center gap-2 text-xs">
              <Badge variant="secondary">{Math.round(monthly.usedPercent)}%</Badge>
              {monthly.resetDescription ? (
                <span className="text-muted-foreground">
                  {t('accounts.mistralVibe.resets', 'Resets {{when}}', {
                    when: monthly.resetDescription
                  })}
                </span>
              ) : null}
            </div>
          </SearchableSetting>
        ) : null}
      </SettingsGroup>
    </div>
  )
}

/** Null when hidden by search or when the scope is a remote host this desktop cannot read. */
export function renderMistralVibeAccountsSection(
  searchQuery: string,
  readsOwnerCredentials: boolean
): React.JSX.Element | null {
  return readsOwnerCredentials &&
    matchesSettingsSearch(searchQuery, getAccountsMistralVibeSearchEntries()) ? (
    <MistralVibeAccountsSection key="mistral-vibe" />
  ) : null
}
