import { useState } from 'react'
import { isWebClientLocation } from '@/lib/web-client-location'
import { ExternalLink, Loader2, Lock, LockOpen, RefreshCw, ShieldCheck } from 'lucide-react'
import { AgentIcon } from '@/lib/agent-catalog'
import { translate } from '@/i18n/i18n'
import {
  ZCODE_PLAN_SITE_CONSOLE_URLS,
  type ZcodePlanSite
} from '../../../../shared/zcode-plan-sites'
import { cn } from '@/lib/utils'
import { useAppStore } from '../../store'
import { useNow } from '../../hooks/use-now'
import { Badge } from '../ui/badge'
import { Button } from '../ui/button'
import { Input } from '../ui/input'
import { Label } from '../ui/label'
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '../ui/select'
import { SearchableSetting } from './SearchableSetting'
import { collectZcodeUsageWindows, ZcodeUsageWindowView } from './zcode-plan-usage-windows'
import { useZcodePlanCredentials } from './use-zcode-plan-credentials'
import { UnsealedCredentialNotice } from './UnsealedCredentialNotice'

const SEARCH_KEYWORDS = [
  'glm',
  'zai',
  'z.ai',
  'zhipu',
  'bigmodel',
  'coding plan',
  'usage',
  'rate limit',
  'zcode'
]

function siteLabel(site: ZcodePlanSite): string {
  if (site === 'bigmodel') {
    return translate(
      'auto.components.settings.ZcodePlanAccountsSection.site.bigmodel',
      'Zhipu · BigModel (open.bigmodel.cn)'
    )
  }
  return translate('auto.components.settings.ZcodePlanAccountsSection.site.zai', 'Z.AI (z.ai)')
}

export function ZcodePlanAccountsSection(): React.JSX.Element {
  const settings = useAppStore((s) => s.settings)
  const updateSettings = useAppStore((s) => s.updateSettings)
  const refreshRateLimits = useAppStore((s) => s.refreshRateLimits)
  const zcodeUsage = useAppStore((s) => s.rateLimits.zcode)
  const { status, apiKeyDraft, setApiKeyDraft, credentialBusy, saveApiKey, clearApiKey } =
    useZcodePlanCredentials(zcodeUsage?.updatedAt)
  const [refreshing, setRefreshing] = useState(false)
  const now = useNow(60_000)

  const credentialEditable = !isWebClientLocation()
  const site = settings?.zcodePlanSite ?? (credentialEditable ? 'zai' : undefined)
  const detailsUnavailable = !credentialEditable || status?.detailsUnavailable === true
  const consoleUrl = site ? ZCODE_PLAN_SITE_CONSOLE_URLS[site] : undefined
  const apiKeyConfigured = status?.apiKeyConfigured === true

  const handleSiteChange = (value: string): void => {
    if (!credentialEditable || (value !== 'zai' && value !== 'bigmodel') || value === site) {
      return
    }
    // Why: main invalidates and refreshes on this settings change, so no local refresh is needed.
    void updateSettings({ zcodePlanSite: value })
  }

  const handleRefreshUsage = async (): Promise<void> => {
    setRefreshing(true)
    try {
      await refreshRateLimits()
    } finally {
      setRefreshing(false)
    }
  }

  const usage = zcodeUsage ?? null
  const usageWindows = collectZcodeUsageWindows(usage)
  const staleUsageError = usage?.status === 'error' ? (usage.error ?? null) : null

  return (
    <section id="accounts-zcode" className="space-y-4 scroll-mt-6">
      <div className="flex items-start justify-between gap-3">
        <div className="space-y-1">
          <h3 className="flex items-center gap-2 text-sm font-semibold">
            <AgentIcon agent="zcode" size={16} />
            {translate(
              'auto.components.settings.ZcodePlanAccountsSection.title',
              'GLM Coding Plan'
            )}
          </h3>
          <p className="text-xs text-muted-foreground">
            {translate(
              'auto.components.settings.ZcodePlanAccountsSection.subtitle',
              'Track Z.AI or Zhipu (BigModel) GLM Coding Plan usage in the status bar. Save the plan API key here — no ZCode CLI setup needed.'
            )}
          </p>
        </div>
        {consoleUrl ? (
          <a
            href={consoleUrl}
            target="_blank"
            rel="noopener noreferrer"
            className="inline-flex items-center gap-1 text-xs text-muted-foreground hover:text-foreground"
          >
            {translate(
              'auto.components.settings.ZcodePlanAccountsSection.consoleLink',
              'Get API key'
            )}
            <ExternalLink className="size-3" />
          </a>
        ) : null}
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
          {detailsUnavailable ? (
            <p className="text-xs text-muted-foreground">
              {translate(
                'auto.components.settings.ZcodePlanAccountsSection.detailsUnavailable',
                'Plan credential details are only readable on the computer running Orca.'
              )}
            </p>
          ) : apiKeyConfigured ? (
            <>
              <p className="text-xs font-medium">
                {translate(
                  'auto.components.settings.ZcodePlanAccountsSection.keyStored',
                  'API key saved · {{value0}}',
                  { value0: siteLabel(site ?? 'zai') }
                )}
              </p>
              <p className="text-xs text-muted-foreground">
                {translate(
                  'auto.components.settings.ZcodePlanAccountsSection.keyStoredHelp',
                  'Stored locally and sent only to the selected site for usage refreshes. It takes priority over the ZCode CLI sign-in.'
                )}
              </p>
            </>
          ) : status?.zcodeCliConfigured ? (
            <>
              <p className="text-xs font-medium">
                {translate(
                  'auto.components.settings.ZcodePlanAccountsSection.usingCli',
                  'Using the ZCode CLI sign-in'
                )}
              </p>
              <p className="text-xs text-muted-foreground">
                {translate(
                  'auto.components.settings.ZcodePlanAccountsSection.usingCliHelp',
                  'Orca reads the Coding Plan key from ~/.zcode/cli/config.json. Save an API key below to link the plan here instead.'
                )}
              </p>
            </>
          ) : (
            <>
              <p className="text-xs font-medium">
                {translate(
                  'auto.components.settings.ZcodePlanAccountsSection.notConfigured',
                  'No GLM Coding Plan linked'
                )}
              </p>
              <p className="text-xs text-muted-foreground">
                {translate(
                  'auto.components.settings.ZcodePlanAccountsSection.notConfiguredHelp',
                  'Save the plan API key below, or sign in with the ZCode CLI on this computer.'
                )}
              </p>
            </>
          )}
          {staleUsageError ? <p className="text-xs text-destructive">{staleUsageError}</p> : null}
        </div>
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
            'auto.components.settings.ZcodePlanAccountsSection.refreshUsage',
            'Refresh usage'
          )}
        </Button>
      </div>

      {!credentialEditable ? (
        <p className="text-xs text-muted-foreground">
          {translate(
            'auto.components.settings.ZcodePlanAccountsSection.hostOnly',
            'Change the plan site and API key in the desktop app on the computer running Orca.'
          )}
        </p>
      ) : null}

      <SearchableSetting
        title={translate(
          'auto.components.settings.ZcodePlanAccountsSection.siteTitle',
          'Plan site'
        )}
        description={translate(
          'auto.components.settings.ZcodePlanAccountsSection.siteDescription',
          'Pick the console your Coding Plan belongs to: Z.AI for the international site, Zhipu BigModel for the mainland site.'
        )}
        keywords={SEARCH_KEYWORDS}
        className="space-y-2"
      >
        <Label htmlFor="zcode-plan-site">
          {translate('auto.components.settings.ZcodePlanAccountsSection.siteTitle', 'Plan site')}
        </Label>
        <Select
          value={site ?? ''}
          onValueChange={handleSiteChange}
          disabled={credentialBusy || !credentialEditable}
        >
          <SelectTrigger id="zcode-plan-site" size="sm" className="w-full">
            <SelectValue
              placeholder={translate(
                'auto.components.settings.ZcodePlanAccountsSection.siteUnavailable',
                'Host plan site unavailable'
              )}
            />
          </SelectTrigger>
          <SelectContent>
            {(['zai', 'bigmodel'] as const).map((option) => (
              <SelectItem key={option} value={option}>
                {siteLabel(option)}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
      </SearchableSetting>

      <SearchableSetting
        title={translate('auto.components.settings.ZcodePlanAccountsSection.keyTitle', 'API key')}
        description={translate(
          'auto.components.settings.ZcodePlanAccountsSection.keyDescription',
          'Paste the API key from the selected console’s API Keys page. Stored locally, encrypted when the OS supports it, and sent only to that site for usage refreshes.'
        )}
        keywords={SEARCH_KEYWORDS}
        className="space-y-2"
      >
        <div className="flex items-center justify-between gap-2">
          <div className="flex items-center gap-2">
            <Label htmlFor="zcode-plan-api-key">
              {translate('auto.components.settings.ZcodePlanAccountsSection.keyTitle', 'API key')}
            </Label>
            {!detailsUnavailable ? (
              <Badge variant={apiKeyConfigured ? 'secondary' : 'outline'}>
                {apiKeyConfigured ? <Lock className="size-3" /> : <LockOpen className="size-3" />}
                {apiKeyConfigured
                  ? translate('auto.components.settings.ZcodePlanAccountsSection.saved', 'Saved')
                  : translate(
                      'auto.components.settings.ZcodePlanAccountsSection.notSaved',
                      'Not saved'
                    )}
              </Badge>
            ) : null}
          </div>
        </div>
        <UnsealedCredentialNotice
          protection={status?.apiKeyProtection ?? null}
          credentialName={translate(
            'auto.components.settings.ZcodePlanAccountsSection.title',
            'GLM Coding Plan'
          )}
        />
        <div className="flex gap-2">
          <Input
            id="zcode-plan-api-key"
            type="password"
            disabled={credentialBusy || !credentialEditable}
            value={apiKeyDraft}
            onChange={(e) => setApiKeyDraft(e.target.value)}
            placeholder={translate(
              'auto.components.settings.ZcodePlanAccountsSection.keyPlaceholder',
              'Paste your GLM Coding Plan API key'
            )}
            spellCheck={false}
            className="flex-1"
          />
          <Button
            size="xs"
            onClick={() => void saveApiKey()}
            disabled={credentialBusy || !credentialEditable || !apiKeyDraft.trim()}
            className="shrink-0"
          >
            {credentialBusy ? <Loader2 className="size-3 animate-spin" /> : null}
            {apiKeyConfigured
              ? translate('auto.components.settings.ZcodePlanAccountsSection.replace', 'Replace')
              : translate('auto.components.settings.ZcodePlanAccountsSection.save', 'Save')}
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
                'auto.components.settings.ZcodePlanAccountsSection.forgetKey',
                'Forget key'
              )}
            </Button>
          ) : null}
        </div>
        <p className="text-xs text-muted-foreground">
          {translate(
            'auto.components.settings.ZcodePlanAccountsSection.keyHelp',
            'The same key your coding tools use for the plan (for example Claude Code with ANTHROPIC_BASE_URL pointed at the site). Switching the site above changes which host receives it.'
          )}
        </p>
      </SearchableSetting>

      {usageWindows.length > 0 ? (
        <SearchableSetting
          title={translate(
            'auto.components.settings.ZcodePlanAccountsSection.usageTitle',
            'Plan usage'
          )}
          description={translate(
            'auto.components.settings.ZcodePlanAccountsSection.usageDescription',
            'Live quota windows for the linked Coding Plan, refreshed with the status bar usage cycle.'
          )}
          keywords={SEARCH_KEYWORDS}
        >
          <div className="space-y-1">
            {usageWindows.map((row) => (
              <ZcodeUsageWindowView key={row.kind} row={row} now={now} />
            ))}
            {usage?.planType ? (
              <p className="text-xs text-muted-foreground">
                {translate(
                  'auto.components.settings.ZcodePlanAccountsSection.planLevel',
                  'Plan: {{value0}}',
                  { value0: usage.planType }
                )}
              </p>
            ) : null}
          </div>
        </SearchableSetting>
      ) : null}
    </section>
  )
}
