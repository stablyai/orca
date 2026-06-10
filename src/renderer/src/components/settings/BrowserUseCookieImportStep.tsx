import { Import, Loader2 } from 'lucide-react'
import { toast } from 'sonner'
import { cn } from '@/lib/utils'
import { Button } from '../ui/button'
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuPortal,
  DropdownMenuSeparator,
  DropdownMenuSub,
  DropdownMenuSubContent,
  DropdownMenuSubTrigger,
  DropdownMenuTrigger
} from '../ui/dropdown-menu'
import { useAppStore } from '../../store'
import { SearchableSetting } from './SearchableSetting'
import { StepBadge } from './BrowserUseStepBadge'
import { getBrowserUsePaneSearchEntries } from './browser-use-search'
import { translate } from '@/i18n/i18n'

type BrowserUseCookieImportStepProps = {
  cookiesImported: boolean
  isImportingDefault: boolean
  step3Blocked: boolean
  sourceLabel: string | null
  onConfigureMoreBrowsers?: () => void
}

export function BrowserUseCookieImportStep({
  cookiesImported,
  isImportingDefault,
  step3Blocked,
  sourceLabel,
  onConfigureMoreBrowsers
}: BrowserUseCookieImportStepProps): React.JSX.Element {
  const detectedBrowsers = useAppStore((s) => s.detectedBrowsers)
  const fetchDetectedBrowsers = useAppStore((s) => s.fetchDetectedBrowsers)

  const handleImportFromBrowser = async (
    browserFamily: string,
    browserProfile?: string
  ): Promise<void> => {
    const profileId = 'default'
    const result = await useAppStore
      .getState()
      .importCookiesFromBrowser(profileId, browserFamily, browserProfile)
    if (result.ok) {
      const browser = detectedBrowsers.find((b) => b.family === browserFamily)
      toast.success(
        translate(
          'auto.components.settings.BrowserUsePane.2ea4617e3a',
          'Imported {{value0}} cookies from {{value1}}{{value2}}.',
          {
            value0: result.summary.importedCookies,
            value1: browser?.label ?? browserFamily,
            value2: browserProfile ? ` (${browserProfile})` : ''
          }
        )
      )
    } else {
      toast.error(result.reason)
    }
  }

  const handleImportFromFile = async (): Promise<void> => {
    const result = await useAppStore.getState().importCookiesToProfile('default')
    if (result.ok) {
      toast.success(
        translate(
          'auto.components.settings.BrowserUsePane.2ea4617e3a',
          'Imported {{value0}} cookies from file.',
          { value0: result.summary.importedCookies }
        )
      )
    } else if (result.reason !== 'canceled') {
      toast.error(result.reason)
    }
  }

  return (
    <SearchableSetting
      title={translate(
        'auto.components.settings.BrowserUsePane.2eb906706c',
        'Import Browser Cookies'
      )}
      description={translate(
        'auto.components.settings.BrowserUsePane.af8c83ed61',
        'Import cookies from Chrome, Edge, or other browsers so agents can reuse your logins.'
      )}
      keywords={getBrowserUsePaneSearchEntries()[2].keywords}
      className={cn(
        'rounded-xl border border-border/60 bg-card/50 p-4',
        step3Blocked && 'opacity-60'
      )}
    >
      <div className="flex items-start gap-3">
        <StepBadge
          index={3}
          state={cookiesImported ? 'done' : isImportingDefault ? 'in-progress' : 'pending'}
        />
        <div className="min-w-0 flex-1 space-y-1">
          <p className="text-sm font-medium">
            {translate(
              'auto.components.settings.BrowserUsePane.2eb906706c',
              'Import Browser Cookies'
            )}
          </p>
          <p className="text-xs text-muted-foreground">
            {translate(
              'auto.components.settings.BrowserUsePane.72d4815523',
              'Bring your existing logins into Orca so agents can reach authenticated pages. Imports into the default profile.'
            )}
          </p>
          {sourceLabel ? (
            <p className="text-[11px] text-muted-foreground">
              {translate(
                'auto.components.settings.BrowserUsePane.112f70adc4',
                'Last imported from'
              )}
              {sourceLabel}
            </p>
          ) : null}
          {onConfigureMoreBrowsers ? (
            <button
              type="button"
              onClick={onConfigureMoreBrowsers}
              className="text-[11px] text-muted-foreground underline underline-offset-2 hover:text-foreground"
            >
              {translate(
                'auto.components.settings.BrowserUsePane.67d9a53f47',
                'Manage profiles for separate logins'
              )}
            </button>
          ) : null}
        </div>
        <DropdownMenu
          onOpenChange={(open) => {
            if (open) {
              void fetchDetectedBrowsers()
            }
          }}
        >
          <DropdownMenuTrigger asChild>
            <Button
              variant={cookiesImported ? 'outline' : 'default'}
              size="sm"
              disabled={isImportingDefault}
              className="gap-1.5"
            >
              {isImportingDefault ? (
                <Loader2 className="size-3.5 animate-spin" />
              ) : (
                <Import className="size-3.5" />
              )}
              {cookiesImported
                ? translate('auto.components.settings.BrowserUsePane.0462565413', 'Re-import')
                : translate('auto.components.settings.BrowserUsePane.2ccfc9cff8', 'Import')}
            </Button>
          </DropdownMenuTrigger>
          <DropdownMenuContent align="end">
            {detectedBrowsers.map((browser) =>
              browser.profiles.length > 1 ? (
                <DropdownMenuSub key={browser.family}>
                  <DropdownMenuSubTrigger>
                    {translate('auto.components.settings.BrowserUsePane.e44c5d681e', 'From')}
                    {browser.label}
                  </DropdownMenuSubTrigger>
                  <DropdownMenuPortal>
                    <DropdownMenuSubContent>
                      {browser.profiles.map((bp) => (
                        <DropdownMenuItem
                          key={bp.directory}
                          onSelect={() =>
                            void handleImportFromBrowser(browser.family, bp.directory)
                          }
                        >
                          {bp.name}
                        </DropdownMenuItem>
                      ))}
                    </DropdownMenuSubContent>
                  </DropdownMenuPortal>
                </DropdownMenuSub>
              ) : (
                <DropdownMenuItem
                  key={browser.family}
                  onSelect={() => void handleImportFromBrowser(browser.family)}
                >
                  {translate('auto.components.settings.BrowserUsePane.e44c5d681e', 'From')}
                  {browser.label}
                </DropdownMenuItem>
              )
            )}
            {detectedBrowsers.length > 0 ? <DropdownMenuSeparator /> : null}
            <DropdownMenuItem onSelect={() => void handleImportFromFile()}>
              {translate('auto.components.settings.BrowserUsePane.be6df68384', 'From File…')}
            </DropdownMenuItem>
          </DropdownMenuContent>
        </DropdownMenu>
      </div>
    </SearchableSetting>
  )
}
