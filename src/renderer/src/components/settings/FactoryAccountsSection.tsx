import { useCallback, useEffect, useState } from 'react'
import { ExternalLink, KeyRound, Loader2, RefreshCw } from 'lucide-react'
import { AgentIcon } from '@/lib/agent-catalog'
import { translate } from '@/i18n/i18n'
import { cn } from '@/lib/utils'
import { useAppStore } from '../../store'
import { Badge } from '../ui/badge'
import { Button } from '../ui/button'
import { Input } from '../ui/input'
import type { FactoryAccountStatus } from '../../../../shared/rate-limit-types'
import { SearchableSetting } from './SearchableSetting'

const FACTORY_API_KEYS_URL = 'https://app.factory.ai/settings/api-keys'

function sourceLabel(source: FactoryAccountStatus['source']): string {
  if (source === 'orca') {
    return translate('auto.components.settings.FactoryAccountsSection.s1a2b3c4d5', 'Saved in Orca')
  }
  if (source === 'env') {
    return 'FACTORY_API_KEY'
  }
  return '~/.factory/.env'
}

function usageRow(
  label: string,
  window: { usedPercent: number; resetDescription: string | null } | null
): React.JSX.Element {
  if (!window) {
    return <div />
  }
  return (
    <div className="flex items-center gap-2 text-xs">
      <span className="w-14 shrink-0 text-muted-foreground">{label}</span>
      <Badge variant="secondary" className="tabular-nums">
        {Math.round(window.usedPercent)}%
      </Badge>
      {window.resetDescription ? (
        <span className="text-muted-foreground">
          {translate(
            'auto.components.settings.FactoryAccountsSection.c6d1a8f4e2',
            'Resets {{when}}',
            {
              when: window.resetDescription
            }
          )}
        </span>
      ) : null}
    </div>
  )
}

export function FactoryAccountsSection(): React.JSX.Element {
  const refreshRateLimits = useAppStore((s) => s.refreshRateLimits)
  const factoryUsage = useAppStore((s) => s.rateLimits.factory)
  const [status, setStatus] = useState<FactoryAccountStatus | null>(null)
  const [loading, setLoading] = useState(true)
  const [refreshing, setRefreshing] = useState(false)
  const [draftKey, setDraftKey] = useState('')
  const [saving, setSaving] = useState(false)

  const loadStatus = useCallback(async (): Promise<void> => {
    try {
      const next = await window.api.factoryAccounts.getStatus()
      setStatus(next)
    } catch (error) {
      console.error('Failed to load Factory account status:', error)
      setStatus({
        configured: false,
        source: null,
        error: error instanceof Error ? error.message : 'Unable to read Factory credentials'
      })
    } finally {
      setLoading(false)
    }
  }, [])

  // Why: re-read after usage refreshes so env/dotenv changes show up, then on mount.
  useEffect(() => {
    void loadStatus()
  }, [loadStatus])

  const handleRefreshUsage = async (): Promise<void> => {
    setRefreshing(true)
    try {
      await refreshRateLimits()
      await loadStatus()
    } finally {
      setRefreshing(false)
    }
  }

  const handleSave = async (): Promise<void> => {
    setSaving(true)
    try {
      const next = await window.api.factoryAccounts.saveApiKey(draftKey)
      setStatus(next)
      setDraftKey('')
    } catch (error) {
      console.error('Failed to save Factory API key:', error)
      setStatus((prev: FactoryAccountStatus | null) => ({
        configured: prev?.configured ?? false,
        source: prev?.source ?? null,
        error: error instanceof Error ? error.message : 'Unable to save Factory API key'
      }))
    } finally {
      setSaving(false)
    }
  }

  const handleClear = async (): Promise<void> => {
    setSaving(true)
    try {
      const next = await window.api.factoryAccounts.clearApiKey()
      setStatus(next)
    } catch (error) {
      console.error('Failed to clear Factory API key:', error)
      setStatus((prev: FactoryAccountStatus | null) => ({
        configured: prev?.configured ?? false,
        source: prev?.source ?? null,
        error: error instanceof Error ? error.message : 'Unable to clear Factory API key'
      }))
    } finally {
      setSaving(false)
    }
  }

  const configured = status?.configured === true
  const source = status?.source ?? null

  return (
    <section id="accounts-factory" className="space-y-4 scroll-mt-6">
      <div className="flex items-start justify-between gap-3">
        <div className="space-y-1">
          <h3 className="flex items-center gap-2 text-sm font-semibold">
            <AgentIcon agent="droid" size={16} />
            {translate(
              'auto.components.settings.FactoryAccountsSection.a1b2c3d4e5',
              'Factory AI (Droid)'
            )}
          </h3>
          <p className="text-xs text-muted-foreground">
            {translate(
              'auto.components.settings.FactoryAccountsSection.f6e5d4c3b2',
              'Shows 5-hour, weekly, and monthly Factory usage from a Factory API key. Orca also reads FACTORY_API_KEY or ~/.factory/.env.'
            )}
          </p>
        </div>
        <a
          href={FACTORY_API_KEYS_URL}
          target="_blank"
          rel="noopener noreferrer"
          className="inline-flex items-center gap-1 text-xs text-muted-foreground hover:text-foreground"
        >
          {translate(
            'auto.components.settings.FactoryAccountsSection.0d8e77bc40',
            'Create API key'
          )}
          <ExternalLink className="size-3" />
        </a>
      </div>

      <div
        className={cn(
          'flex items-start gap-3 rounded-lg border bg-muted/20 p-3',
          configured ? 'border-border/60' : 'border-border/40'
        )}
      >
        <KeyRound
          className={cn(
            'mt-0.5 size-4 shrink-0',
            configured ? 'text-foreground' : 'text-muted-foreground'
          )}
        />
        <div className="min-w-0 flex-1 space-y-1">
          {loading ? (
            <p className="text-xs text-muted-foreground">
              {translate('auto.components.settings.FactoryAccountsSection.ad47a33f72', 'Loading…')}
            </p>
          ) : configured ? (
            <>
              <p className="text-xs font-medium">
                {translate(
                  'auto.components.settings.FactoryAccountsSection.b2c3d4e5f6',
                  'API key ready'
                )}
              </p>
              <p className="text-xs text-muted-foreground">
                {source === 'orca'
                  ? sourceLabel(source)
                  : translate(
                      'auto.components.settings.FactoryAccountsSection.d4e5f6a7b8',
                      'From {{source}}. Orca cannot clear keys set outside the app.',
                      { source: sourceLabel(source) }
                    )}
              </p>
            </>
          ) : (
            <>
              <p className="text-xs font-medium">
                {translate(
                  'auto.components.settings.FactoryAccountsSection.e5f6a7b8c9',
                  'No Factory API key'
                )}
              </p>
              <p className="text-xs text-muted-foreground">
                {translate(
                  'auto.components.settings.FactoryAccountsSection.f6a7b8c9d0',
                  'Paste a key below, or set FACTORY_API_KEY / ~/.factory/.env and click Refresh usage.'
                )}
              </p>
            </>
          )}
          {status?.error ? <p className="text-xs text-destructive">{status.error}</p> : null}
        </div>
        <Button
          variant="outline"
          size="xs"
          disabled={refreshing}
          onClick={() => void handleRefreshUsage()}
          className="shrink-0 gap-1"
        >
          {refreshing ? (
            <Loader2 className="size-3 animate-spin" />
          ) : (
            <RefreshCw className="size-3" />
          )}
          {translate('auto.components.settings.FactoryAccountsSection.3325d996cb', 'Refresh usage')}
        </Button>
      </div>

      <SearchableSetting
        title={translate('auto.components.settings.FactoryAccountsSection.b7e2d9f0a3', 'API key')}
        description={translate(
          'auto.components.settings.FactoryAccountsSection.a9c8e7d6f5',
          'Stored encrypted in ~/.orca. Env and dotenv sources are read-only here.'
        )}
        keywords={['factory', 'droid', 'api key', 'usage', 'quota']}
      >
        <div className="flex items-center gap-2">
          <Input
            type="password"
            value={draftKey}
            onChange={(e) => setDraftKey(e.target.value)}
            placeholder={translate(
              'auto.components.settings.FactoryAccountsSection.k1e2y3p4a5',
              'fk-…'
            )}
            spellCheck={false}
            className="text-xs"
          />
          <Button
            variant="outline"
            size="xs"
            disabled={saving || draftKey.trim().length === 0}
            onClick={() => void handleSave()}
            className="shrink-0"
          >
            {saving ? <Loader2 className="size-3 animate-spin" /> : null}
            {translate('auto.components.settings.FactoryAccountsSection.s4v3e2k1e0', 'Save')}
          </Button>
          {source === 'orca' ? (
            <Button
              variant="outline"
              size="xs"
              disabled={saving}
              onClick={() => void handleClear()}
              className="shrink-0"
            >
              {translate('auto.components.settings.FactoryAccountsSection.c1l3e5a7r9', 'Clear')}
            </Button>
          ) : null}
        </div>
      </SearchableSetting>

      {factoryUsage &&
      (factoryUsage.session || factoryUsage.weekly || factoryUsage.monthly) &&
      factoryUsage.status !== 'unavailable' ? (
        <SearchableSetting
          title={translate('auto.components.settings.FactoryAccountsSection.u5s6a7g8e9', 'Usage')}
          description={translate(
            'auto.components.settings.FactoryAccountsSection.m0o1n2t3h4',
            'Same quota windows as the Factory dashboard.'
          )}
          keywords={['factory', 'usage', '5-hour', 'weekly', 'monthly']}
        >
          <div className="space-y-1">
            {usageRow(
              translate('auto.components.settings.FactoryAccountsSection.h5o0u1r2s3', '5-hour'),
              factoryUsage.session
            )}
            {usageRow(
              translate('auto.components.settings.FactoryAccountsSection.w1e2e3k4l5', 'Weekly'),
              factoryUsage.weekly
            )}
            {usageRow(
              translate('auto.components.settings.FactoryAccountsSection.m6o7n8t9h0', 'Monthly'),
              factoryUsage.monthly ?? null
            )}
            {factoryUsage.usageMetadata?.authProvenance ? (
              <p className="truncate text-xs text-muted-foreground">
                {factoryUsage.usageMetadata.authProvenance}
              </p>
            ) : null}
          </div>
        </SearchableSetting>
      ) : null}
    </section>
  )
}
