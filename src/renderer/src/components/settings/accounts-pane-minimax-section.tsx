import { ExternalLink, HelpCircle, Loader2, Lock, LockOpen, ShieldCheck } from 'lucide-react'
import { translate } from '@/i18n/i18n'
import { formatUiRelativeTime } from '@/i18n/relative-time-format'
import { cn } from '@/lib/utils'
import { Badge } from '../ui/badge'
import { Button } from '../ui/button'
import { Input } from '../ui/input'
import { Label } from '../ui/label'
import { Popover, PopoverContent, PopoverTrigger } from '../ui/popover'
import { MiniMaxIcon } from '../status-bar/icons'
import { SearchableSetting } from './SearchableSetting'
import type { AccountsPaneSectionModel } from './accounts-pane-types'

const MINIMAX_CONSOLE_URL = 'https://platform.minimax.io/console/usage'

function formatMiniMaxRelativeRefresh(updatedAt: number, now: number): string {
  const diffMs = Math.max(0, now - updatedAt)
  if (diffMs < 60_000) {
    return translate('auto.components.settings.AccountsPane.3a30aaf526', 'just now')
  }
  return formatUiRelativeTime(-diffMs)
}

function MiniMaxCookieHelpPopover(): React.JSX.Element {
  const steps = [
    translate(
      'auto.components.settings.AccountsPane.f5d8d2a6a1',
      'Open platform.minimax.io/console/usage in your browser and sign in.'
    ),
    translate('auto.components.settings.AccountsPane.24560fe830', 'Open DevTools.'),
    translate(
      'auto.components.settings.AccountsPane.4cab0fa42d',
      'Go to the Network tab and enable Preserve log.'
    ),
    translate('auto.components.settings.AccountsPane.bee4e63e1c', 'Reload the page.'),
    translate(
      'auto.components.settings.AccountsPane.87f814af6f',
      'Filter for remains and select the coding_plan/remains request.'
    ),
    translate(
      'auto.components.settings.AccountsPane.435df0ee51',
      'Under Request Headers, copy the Cookie value.'
    ),
    translate('auto.components.settings.AccountsPane.7492fb3bba', 'Paste it here and click Save.')
  ]
  return (
    <div className="space-y-3 p-3 text-xs">
      <div className="space-y-1">
        <p className="font-medium">
          {translate('auto.components.settings.AccountsPane.9fec52de4b', 'How to copy the cookie')}
        </p>
        <p className="text-muted-foreground">
          {translate(
            'auto.components.settings.AccountsPane.4e32e030b2',
            'Stored locally. Orca sends it only to platform.minimax.io for usage refreshes.'
          )}
        </p>
      </div>
      <ol className="list-decimal space-y-1 pl-4 text-muted-foreground">
        {steps.map((step) => (
          <li key={step}>{step}</li>
        ))}
      </ol>
    </div>
  )
}

export function renderMiniMaxAccountsSection(model: AccountsPaneSectionModel): React.JSX.Element {
  const {
    clearMiniMaxCookie,
    miniMaxConfigured,
    miniMaxCookieDraft,
    miniMaxCredentialBusy,
    miniMaxRateLimits,
    saveMiniMaxCookie,
    setMiniMaxCookieDraft,
    settings,
    updateSettings
  } = model
  return (
    <section key="minimax" id="accounts-minimax" className="space-y-4 scroll-mt-6">
      <div className="flex items-start justify-between gap-3">
        <div className="space-y-1">
          <h3 className="flex items-center gap-2 text-sm font-semibold">
            <MiniMaxIcon size={16} />
            {translate('auto.components.settings.AccountsPane.5d63bbfbec', 'MiniMax')}
          </h3>
          <p className="text-xs text-muted-foreground">
            {translate(
              'auto.components.settings.AccountsPane.15e831350e',
              'Configure MiniMax usage tracking from platform.minimax.io.'
            )}
          </p>
        </div>
        <a
          href={MINIMAX_CONSOLE_URL}
          target="_blank"
          rel="noopener noreferrer"
          className="inline-flex items-center gap-1 text-xs text-muted-foreground hover:text-foreground"
        >
          {translate('auto.components.settings.AccountsPane.0d8e77bc40', 'Open console')}
          <ExternalLink className="size-3" />
        </a>
      </div>

      <div
        className={cn(
          'flex items-start gap-3 rounded-lg border bg-muted/20 p-3',
          miniMaxConfigured ? 'border-border/60' : 'border-border/40'
        )}
      >
        <ShieldCheck
          className={cn(
            'mt-0.5 size-4 shrink-0',
            miniMaxConfigured ? 'text-foreground' : 'text-muted-foreground'
          )}
        />
        <div className="space-y-0.5">
          <p className="text-xs font-medium">
            {miniMaxConfigured
              ? translate('auto.components.settings.AccountsPane.0b8c1c7e02', 'Stored locally')
              : translate('auto.components.settings.AccountsPane.1fd1b1b6b4', 'Cookie not set')}
          </p>
          <p className="text-xs text-muted-foreground">
            {translate(
              'auto.components.settings.AccountsPane.5e08b0fe57',
              'Stored locally and sent only to platform.minimax.io for usage refreshes.'
            )}
          </p>
        </div>
      </div>

      <SearchableSetting
        title={translate(
          'auto.components.settings.AccountsPane.21d6eb141e',
          'MiniMax Session Cookie'
        )}
        description={translate(
          'auto.components.settings.AccountsPane.33bba5ad83',
          'Paste your MiniMax session cookie for local rate-limit fetching.'
        )}
        keywords={['minimax', 'cookie', 'session', 'rate limit', 'status bar']}
        className="space-y-2"
      >
        <div className="flex items-center justify-between gap-2">
          <div className="flex items-center gap-2">
            <Label>
              {translate(
                'auto.components.settings.AccountsPane.21d6eb141e',
                'MiniMax Session Cookie'
              )}
            </Label>
            <Badge
              variant={miniMaxConfigured ? 'secondary' : 'outline'}
              className="h-5 gap-1 rounded-full px-2 text-[10px] font-medium text-muted-foreground"
            >
              {miniMaxConfigured ? <Lock className="size-3" /> : <LockOpen className="size-3" />}
              {miniMaxConfigured
                ? translate('auto.components.settings.AccountsPane.73ea15f24b', 'Saved')
                : translate('auto.components.settings.AccountsPane.23afe8f226', 'Not saved')}
            </Badge>
          </div>
          <Popover>
            <PopoverTrigger asChild>
              <Button
                variant="ghost"
                size="xs"
                className="h-6 gap-1 px-2 text-xs text-muted-foreground hover:text-foreground"
              >
                <HelpCircle className="size-3" />
                {translate('auto.components.settings.AccountsPane.43d7a45b97', 'How to copy')}
              </Button>
            </PopoverTrigger>
            <PopoverContent align="end" side="bottom" sideOffset={6} className="w-80 p-0">
              <MiniMaxCookieHelpPopover />
            </PopoverContent>
          </Popover>
        </div>
        <div className="flex gap-2">
          <Input
            type="password"
            value={miniMaxCookieDraft}
            onChange={(e) => setMiniMaxCookieDraft(e.target.value)}
            placeholder={translate(
              'auto.components.settings.AccountsPane.b8a4f21c3e',
              'Paste the Cookie header from DevTools'
            )}
            spellCheck={false}
            className="flex-1 text-xs"
          />
          <Button
            size="xs"
            onClick={() => void saveMiniMaxCookie()}
            disabled={miniMaxCredentialBusy || !miniMaxCookieDraft.trim()}
            className="h-7 shrink-0 text-xs"
          >
            {miniMaxCredentialBusy ? <Loader2 className="size-3 animate-spin" /> : null}
            {miniMaxConfigured
              ? translate('auto.components.settings.AccountsPane.f38b9cc4bd', 'Replace')
              : translate('auto.components.settings.AccountsPane.590a3130f9', 'Save')}
          </Button>
          {miniMaxConfigured ? (
            <Button
              variant="ghost"
              size="xs"
              onClick={() => void clearMiniMaxCookie()}
              disabled={miniMaxCredentialBusy}
              className="h-7 shrink-0 text-xs text-muted-foreground hover:text-foreground"
            >
              {translate('auto.components.settings.AccountsPane.316ca4e610', 'Forget cookie')}
            </Button>
          ) : null}
        </div>
        <p className="text-xs text-muted-foreground">
          {translate(
            'auto.components.settings.AccountsPane.79418c782a',
            'Open platform.minimax.io/console/usage in your browser, sign in, then copy the Cookie request header from DevTools (Network → any remains request → Cookie).'
          )}
        </p>
        {miniMaxConfigured &&
        miniMaxRateLimits?.status === 'ok' &&
        miniMaxRateLimits.error === null ? (
          <p className="text-xs text-muted-foreground">
            {translate(
              'auto.components.settings.AccountsPane.53f7b8c7a2',
              'Last refresh: {{value0}}',
              {
                value0: formatMiniMaxRelativeRefresh(miniMaxRateLimits.updatedAt, Date.now())
              }
            )}
          </p>
        ) : null}
        <p className="text-xs text-muted-foreground">
          {translate(
            'auto.components.settings.AccountsPane.31d24a4e87',
            'Cookie expires when you sign out in the browser.'
          )}
        </p>
      </SearchableSetting>

      <div className="space-y-3 rounded-lg border border-border/60 bg-muted/20 p-3">
        <div className="flex items-center justify-between gap-3">
          <div className="space-y-1">
            <h4 className="text-xs font-semibold text-muted-foreground">
              {translate('auto.components.settings.AccountsPane.9dd50d3f75', 'Advanced')}
            </h4>
            <p className="text-xs text-muted-foreground">
              {translate(
                'auto.components.settings.AccountsPane.174fb408f9',
                'Leave these defaults alone unless MiniMax usage refresh points at the wrong workspace or model.'
              )}
            </p>
          </div>
        </div>

        <SearchableSetting
          title={translate('auto.components.settings.AccountsPane.bf160bb6c0', 'Group ID override')}
          description={translate(
            'auto.components.settings.AccountsPane.b1e2743313',
            'Optional. Leave blank to use minimax_group_id_v2 from the cookie.'
          )}
          keywords={['minimax', 'group', 'id', 'rate limit']}
          className="space-y-2"
        >
          <Label>
            {translate('auto.components.settings.AccountsPane.bf160bb6c0', 'Group ID override')}
          </Label>
          <Input
            type="text"
            value={settings.minimaxGroupId}
            onChange={(e) => updateSettings({ minimaxGroupId: e.target.value })}
            placeholder={translate(
              'auto.components.settings.AccountsPane.0747d6391a',
              'Use group ID from cookie'
            )}
            spellCheck={false}
            className="text-xs"
          />
        </SearchableSetting>

        <SearchableSetting
          title={translate('auto.components.settings.AccountsPane.4ff2af7524', 'Usage model names')}
          description={translate(
            'auto.components.settings.AccountsPane.5cf4b0f85f',
            'Optional comma-separated model names. Leave as general unless MiniMax returns a model-specific error.'
          )}
          keywords={['minimax', 'model', 'general', 'rate limit']}
          className="space-y-2"
        >
          <Label>
            {translate('auto.components.settings.AccountsPane.4ff2af7524', 'Usage model names')}
          </Label>
          <Input
            type="text"
            value={settings.minimaxUsageModels}
            onChange={(e) => updateSettings({ minimaxUsageModels: e.target.value })}
            placeholder={translate('auto.components.settings.AccountsPane.3c92b0d31c', 'general')}
            spellCheck={false}
            className="text-xs"
          />
        </SearchableSetting>
      </div>
    </section>
  )
}
