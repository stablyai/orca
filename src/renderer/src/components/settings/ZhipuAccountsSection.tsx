import { useCallback, useEffect, useId, useState } from 'react'
import { Download, ExternalLink, Loader2, RefreshCw, ShieldCheck, Trash2 } from 'lucide-react'
import { ZHIPU_DEFAULT_BASE_URL } from '../../../../shared/zhipu-usage'
import { translate } from '@/i18n/i18n'
import { cn } from '@/lib/utils'
import { useAppStore } from '../../store'
import { ZhipuIcon } from '../status-bar/icons'
import { Badge } from '../ui/badge'
import { Button } from '../ui/button'
import { Input } from '../ui/input'
import { Label } from '../ui/label'
import { SearchableSetting } from './SearchableSetting'

const ZHIPU_USAGE_PLUGIN_URL =
  'https://github.com/zai-org/zai-coding-plugins/tree/main/plugins/glm-plan-usage'

type ZhipuCredentialsStatus = {
  configured: boolean
  baseUrl: string | null
}

function usageBadge(label: string, usedPercent: number): React.JSX.Element {
  return (
    <div className="flex items-center gap-2 text-xs">
      <span className="text-muted-foreground">{label}</span>
      <Badge variant="secondary" className="tabular-nums">
        {Math.round(usedPercent)}%
      </Badge>
    </div>
  )
}

export function ZhipuAccountsSection(): React.JSX.Element {
  const refreshZhipuRateLimits = useAppStore((s) => s.refreshZhipuRateLimits)
  const zhipuUsage = useAppStore((s) => s.rateLimits.zhipu)
  const baseUrlInputId = useId()
  const tokenInputId = useId()
  const [status, setStatus] = useState<ZhipuCredentialsStatus | null>(null)
  const [baseUrlDraft, setBaseUrlDraft] = useState(ZHIPU_DEFAULT_BASE_URL)
  const [authTokenDraft, setAuthTokenDraft] = useState('')
  const [loading, setLoading] = useState(true)
  const [saving, setSaving] = useState(false)
  const [importing, setImporting] = useState(false)
  const [refreshing, setRefreshing] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [notice, setNotice] = useState<string | null>(null)

  const loadStatus = useCallback(async (): Promise<void> => {
    try {
      const next = await window.api.zhipuCredentials.getStatus()
      setStatus(next)
      setBaseUrlDraft(next.baseUrl ?? ZHIPU_DEFAULT_BASE_URL)
      setError(null)
    } catch (loadError) {
      console.error('Failed to load Zhipu credential status:', loadError)
      setStatus({ configured: false, baseUrl: null })
      setError(loadError instanceof Error ? loadError.message : 'Unable to read Zhipu credentials')
    } finally {
      setLoading(false)
    }
  }, [])

  useEffect(() => {
    void loadStatus()
  }, [loadStatus])

  const handleSave = async (): Promise<void> => {
    if (!authTokenDraft.trim()) {
      setError(
        translate(
          'auto.components.settings.ZhipuAccountsSection.tokenRequired',
          'Zhipu auth token is required.'
        )
      )
      return
    }
    setSaving(true)
    try {
      const next = await window.api.zhipuCredentials.save({
        baseUrl: baseUrlDraft.trim() || ZHIPU_DEFAULT_BASE_URL,
        authToken: authTokenDraft.trim()
      })
      setStatus(next)
      setBaseUrlDraft(next.baseUrl ?? ZHIPU_DEFAULT_BASE_URL)
      setAuthTokenDraft('')
      setError(null)
      setNotice(null)
      await refreshZhipuRateLimits()
    } catch (saveError) {
      console.error('Failed to save Zhipu credentials:', saveError)
      setError(saveError instanceof Error ? saveError.message : 'Zhipu credentials were not saved.')
    } finally {
      setSaving(false)
    }
  }

  const handleClear = async (): Promise<void> => {
    setSaving(true)
    try {
      const next = await window.api.zhipuCredentials.clear()
      setStatus(next)
      setBaseUrlDraft(ZHIPU_DEFAULT_BASE_URL)
      setAuthTokenDraft('')
      setError(null)
      setNotice(null)
      await refreshZhipuRateLimits()
    } catch (clearError) {
      console.error('Failed to clear Zhipu credentials:', clearError)
      setError(
        clearError instanceof Error ? clearError.message : 'Zhipu credentials were not cleared.'
      )
    } finally {
      setSaving(false)
    }
  }

  const handleImportFromCcSwitch = async (): Promise<void> => {
    setImporting(true)
    try {
      const next = await window.api.zhipuCredentials.importFromCcSwitch()
      setStatus({
        configured: next.configured,
        baseUrl: next.baseUrl
      })
      setBaseUrlDraft(next.baseUrl ?? ZHIPU_DEFAULT_BASE_URL)
      setAuthTokenDraft('')
      setError(null)
      setNotice(
        translate(
          'auto.components.settings.ZhipuAccountsSection.ccSwitchImported',
          'Imported current cc-switch Claude provider: {{provider}}.',
          { provider: next.importedProviderName }
        )
      )
      await refreshZhipuRateLimits()
    } catch (importError) {
      console.error('Failed to import Zhipu credentials from cc-switch:', importError)
      setNotice(null)
      setError(
        importError instanceof Error
          ? importError.message
          : translate(
              'auto.components.settings.ZhipuAccountsSection.ccSwitchImportFailed',
              'cc-switch import failed.'
            )
      )
    } finally {
      setImporting(false)
    }
  }

  const handleRefreshUsage = async (): Promise<void> => {
    setRefreshing(true)
    try {
      await refreshZhipuRateLimits()
      await loadStatus()
    } finally {
      setRefreshing(false)
    }
  }

  const configured = status?.configured === true
  const usageAvailable = zhipuUsage?.session || zhipuUsage?.monthly

  return (
    <section id="accounts-zhipu" className="space-y-4 scroll-mt-6">
      <div className="flex items-start justify-between gap-3">
        <div className="space-y-1">
          <h3 className="flex items-center gap-2 text-sm font-semibold">
            <ZhipuIcon size={16} />
            {translate('auto.components.settings.ZhipuAccountsSection.title', 'Zhipu / Z.AI')}
          </h3>
          <p className="text-xs text-muted-foreground">
            {translate(
              'auto.components.settings.ZhipuAccountsSection.description',
              'Shows GLM Coding Plan quota from your Zhipu / Z.AI Anthropic-compatible token.'
            )}
          </p>
        </div>
        <a
          href={ZHIPU_USAGE_PLUGIN_URL}
          target="_blank"
          rel="noopener noreferrer"
          className="inline-flex items-center gap-1 text-xs text-muted-foreground hover:text-foreground"
        >
          {translate('auto.components.settings.ZhipuAccountsSection.docsLink', 'Usage plugin')}
          <ExternalLink className="size-3" />
        </a>
      </div>

      <div
        className={cn(
          'flex items-start gap-3 rounded-lg border bg-muted/20 p-3',
          configured ? 'border-border/60' : 'border-border/40'
        )}
      >
        <ShieldCheck
          className={cn(
            'mt-0.5 size-4 shrink-0',
            configured ? 'text-foreground' : 'text-muted-foreground'
          )}
        />
        <div className="min-w-0 flex-1 space-y-1">
          {loading ? (
            <p className="text-xs text-muted-foreground">
              {translate('auto.components.settings.ZhipuAccountsSection.loading', 'Loading...')}
            </p>
          ) : configured ? (
            <>
              <p className="truncate text-xs font-medium">
                {status?.baseUrl ?? ZHIPU_DEFAULT_BASE_URL}
              </p>
              <p className="text-xs text-muted-foreground">
                {translate(
                  'auto.components.settings.ZhipuAccountsSection.configuredCopy',
                  'Token stored locally. Orca only uses it for Zhipu / Z.AI usage refreshes.'
                )}
              </p>
            </>
          ) : (
            <>
              <p className="text-xs font-medium">
                {translate(
                  'auto.components.settings.ZhipuAccountsSection.notConfigured',
                  'Zhipu usage is not configured'
                )}
              </p>
              <p className="text-xs text-muted-foreground">
                {translate(
                  'auto.components.settings.ZhipuAccountsSection.notConfiguredCopy',
                  'Paste the same ANTHROPIC_AUTH_TOKEN used by GLM Coding Plan tools.'
                )}
              </p>
            </>
          )}
          {error ? <p className="text-xs text-destructive">{error}</p> : null}
          {notice ? <p className="text-xs text-muted-foreground">{notice}</p> : null}
          {zhipuUsage?.error ? (
            <p className="text-xs text-destructive">{zhipuUsage.error}</p>
          ) : null}
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
          {translate('auto.components.settings.ZhipuAccountsSection.refreshUsage', 'Refresh usage')}
        </Button>
      </div>

      <SearchableSetting
        title={translate(
          'auto.components.settings.ZhipuAccountsSection.credentialsTitle',
          'Zhipu Usage Credentials'
        )}
        description={translate(
          'auto.components.settings.ZhipuAccountsSection.credentialsDescription',
          'Store a local token for GLM Coding Plan quota refreshes, or import your current cc-switch Claude provider.'
        )}
        keywords={[
          'zhipu',
          'z.ai',
          'glm',
          'coding plan',
          'quota',
          'token',
          'anthropic',
          'cc-switch'
        ]}
        className="space-y-3"
      >
        <div className="grid gap-3 sm:grid-cols-[minmax(0,1fr)_minmax(0,1fr)]">
          <div className="space-y-2">
            <Label htmlFor={baseUrlInputId}>
              {translate('auto.components.settings.ZhipuAccountsSection.baseUrl', 'Base URL')}
            </Label>
            <Input
              id={baseUrlInputId}
              type="url"
              value={baseUrlDraft}
              onChange={(event) => setBaseUrlDraft(event.target.value)}
              placeholder={ZHIPU_DEFAULT_BASE_URL}
              spellCheck={false}
              className="font-mono text-xs"
            />
          </div>
          <div className="space-y-2">
            <Label htmlFor={tokenInputId}>
              {translate(
                'auto.components.settings.ZhipuAccountsSection.authToken',
                'ANTHROPIC_AUTH_TOKEN'
              )}
            </Label>
            <Input
              id={tokenInputId}
              type="password"
              value={authTokenDraft}
              onChange={(event) => setAuthTokenDraft(event.target.value)}
              placeholder={
                configured
                  ? translate(
                      'auto.components.settings.ZhipuAccountsSection.storedTokenPlaceholder',
                      'Stored; paste a new token to replace'
                    )
                  : translate(
                      'auto.components.settings.ZhipuAccountsSection.pasteTokenPlaceholder',
                      'Paste token'
                    )
              }
              spellCheck={false}
              className="font-mono text-xs"
            />
          </div>
        </div>
        <div className="flex flex-wrap items-center gap-2">
          <Button
            variant="outline"
            size="xs"
            onClick={() => void handleImportFromCcSwitch()}
            disabled={saving || importing}
            className="gap-1"
          >
            {importing ? (
              <Loader2 className="size-3 animate-spin" />
            ) : (
              <Download className="size-3" />
            )}
            {translate(
              'auto.components.settings.ZhipuAccountsSection.importFromCcSwitch',
              'Import from cc-switch'
            )}
          </Button>
          <Button
            size="xs"
            onClick={() => void handleSave()}
            disabled={saving || importing || !authTokenDraft.trim()}
            className="gap-1"
          >
            {saving ? <Loader2 className="size-3 animate-spin" /> : null}
            {configured
              ? translate(
                  'auto.components.settings.ZhipuAccountsSection.replaceToken',
                  'Replace token'
                )
              : translate('auto.components.settings.ZhipuAccountsSection.saveToken', 'Save token')}
          </Button>
          {configured ? (
            <Button
              variant="outline"
              size="xs"
              onClick={() => void handleClear()}
              disabled={saving || importing}
              className="gap-1"
            >
              <Trash2 className="size-3" />
              {translate(
                'auto.components.settings.ZhipuAccountsSection.clearToken',
                'Forget token'
              )}
            </Button>
          ) : null}
        </div>
      </SearchableSetting>

      {usageAvailable ? (
        <SearchableSetting
          title={translate('auto.components.settings.ZhipuAccountsSection.quotaTitle', 'Quota')}
          description={translate(
            'auto.components.settings.ZhipuAccountsSection.quotaDescription',
            'Same quota windows returned by the official GLM plan usage plugin.'
          )}
          keywords={['zhipu', 'z.ai', 'glm', 'quota', 'usage']}
        >
          <div className="flex flex-wrap items-center gap-x-4 gap-y-2">
            {zhipuUsage?.session
              ? usageBadge(
                  translate(
                    'auto.components.settings.ZhipuAccountsSection.tokensUsage',
                    '5-hour tokens'
                  ),
                  zhipuUsage.session.usedPercent
                )
              : null}
            {zhipuUsage?.monthly
              ? usageBadge(
                  translate(
                    'auto.components.settings.ZhipuAccountsSection.monthlyUsage',
                    'Monthly MCP'
                  ),
                  zhipuUsage.monthly.usedPercent
                )
              : null}
          </div>
        </SearchableSetting>
      ) : null}
    </section>
  )
}
