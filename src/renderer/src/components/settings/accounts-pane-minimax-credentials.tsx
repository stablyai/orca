import { HelpCircle, Loader2, Lock, LockOpen } from 'lucide-react'
import { useNow } from '../../hooks/use-now'
import { translate } from '@/i18n/i18n'
import { formatUiRelativeTime } from '@/i18n/relative-time-format'
import { Badge } from '../ui/badge'
import { Button } from '../ui/button'
import { Input } from '../ui/input'
import { Label } from '../ui/label'
import { Popover, PopoverContent, PopoverTrigger } from '../ui/popover'
import { SearchableSetting } from './SearchableSetting'
import type { AccountsPaneSectionModel } from './accounts-pane-types'

function formatMiniMaxRelativeRefresh(updatedAt: number, now: number): string {
  const diffMs = Math.max(0, now - updatedAt)
  if (diffMs < 60_000) {
    return translate('auto.components.settings.AccountsPane.3a30aaf526', 'just now')
  }
  return formatUiRelativeTime(-diffMs)
}

function MiniMaxCookieHelpPopover({ consoleUrl }: { consoleUrl: string }): React.JSX.Element {
  const steps = [
    translate(
      'auto.components.settings.AccountsPane.openSelectedConsole',
      'Open {{url}} in your browser and sign in.',
      { url: consoleUrl }
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
            'auto.components.settings.AccountsPane.cookieSelectedEndpoint',
            'Stored locally and sent to the selected MiniMax endpoint for usage refreshes.'
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

export function MiniMaxCredentials({
  model,
  consoleUrl
}: {
  model: AccountsPaneSectionModel
  consoleUrl: string
}): React.JSX.Element {
  const {
    miniMaxCookieDraft,
    setMiniMaxCookieDraft,
    miniMaxConfigured,
    miniMaxCredentialBusy,
    miniMaxRateLimits,
    saveMiniMaxCookie,
    clearMiniMaxCookie,
    miniMaxApiKeyDraft,
    setMiniMaxApiKeyDraft,
    miniMaxApiKeyConfigured,
    saveMiniMaxApiKey,
    clearMiniMaxApiKey
  } = model
  const now = useNow(60_000)
  return (
    <>
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
            <Label htmlFor="minimax-cookie">
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
              <MiniMaxCookieHelpPopover consoleUrl={consoleUrl} />
            </PopoverContent>
          </Popover>
        </div>
        <div className="flex gap-2">
          <Input
            id="minimax-cookie"
            type="password"
            disabled={miniMaxCredentialBusy}
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
            'auto.components.settings.AccountsPane.copySelectedConsoleCookie',
            'Open the selected console, sign in, then copy the Cookie request header from DevTools (Network → any remains request → Cookie).'
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
                value0: formatMiniMaxRelativeRefresh(miniMaxRateLimits.updatedAt, now)
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

      <SearchableSetting
        title={translate('auto.components.settings.AccountsPane.83b6a1f7c4', 'MiniMax API key')}
        description={translate(
          'auto.components.settings.AccountsPane.apiKeySelectedEndpoint',
          'Paste the API key from your MiniMax console → API keys. Stored locally and sent to the selected MiniMax endpoint for usage refreshes. The API key takes priority over the cookie.'
        )}
        keywords={['minimax', 'api', 'key', 'cn', 'china', 'bearer', 'rate limit']}
        className="space-y-2"
      >
        <div className="flex items-center justify-between gap-2">
          <div className="flex items-center gap-2">
            <Label htmlFor="minimax-api-key">
              {translate('auto.components.settings.AccountsPane.83b6a1f7c4', 'MiniMax API key')}
            </Label>
            <Badge
              variant={miniMaxApiKeyConfigured ? 'secondary' : 'outline'}
              className="h-5 gap-1 rounded-full px-2 text-[10px] font-medium text-muted-foreground"
            >
              {miniMaxApiKeyConfigured ? (
                <Lock className="size-3" />
              ) : (
                <LockOpen className="size-3" />
              )}
              {miniMaxApiKeyConfigured
                ? translate('auto.components.settings.AccountsPane.73ea15f24b', 'Saved')
                : translate('auto.components.settings.AccountsPane.23afe8f226', 'Not saved')}
            </Badge>
          </div>
        </div>
        <div className="flex gap-2">
          <Input
            id="minimax-api-key"
            type="password"
            disabled={miniMaxCredentialBusy}
            value={miniMaxApiKeyDraft}
            onChange={(e) => setMiniMaxApiKeyDraft(e.target.value)}
            placeholder={translate(
              'auto.components.settings.AccountsPane.4f2c8a7e1b',
              'Paste your MiniMax API key'
            )}
            spellCheck={false}
            className="flex-1 text-xs"
          />
          <Button
            size="xs"
            onClick={() => void saveMiniMaxApiKey()}
            disabled={miniMaxCredentialBusy || !miniMaxApiKeyDraft.trim()}
            className="h-7 shrink-0 text-xs"
          >
            {miniMaxCredentialBusy ? <Loader2 className="size-3 animate-spin" /> : null}
            {miniMaxApiKeyConfigured
              ? translate('auto.components.settings.AccountsPane.f38b9cc4bd', 'Replace')
              : translate('auto.components.settings.AccountsPane.590a3130f9', 'Save')}
          </Button>
          {miniMaxApiKeyConfigured ? (
            <Button
              variant="ghost"
              size="xs"
              onClick={() => void clearMiniMaxApiKey()}
              disabled={miniMaxCredentialBusy}
              className="h-7 shrink-0 text-xs text-muted-foreground hover:text-foreground"
            >
              {translate('auto.components.settings.AccountsPane.a7b1e3c5d2', 'Forget key')}
            </Button>
          ) : null}
        </div>
        <p className="text-xs text-muted-foreground">
          {translate(
            'auto.components.settings.AccountsPane.apiKeyInstructions',
            'Copy the API key from your MiniMax console → API keys. A saved API key takes priority over the cookie; use Forget key to switch back to the cookie.'
          )}
        </p>
      </SearchableSetting>
    </>
  )
}
