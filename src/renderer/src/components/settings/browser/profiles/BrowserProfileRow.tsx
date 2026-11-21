import { useState } from 'react'
import { Import, Loader2, RefreshCw, Trash2 } from 'lucide-react'
import { toast } from 'sonner'
import { emitBrowserCookieImportToast } from '@/lib/browser/cookies/browser-cookie-import-toast'
import type {
  BrowserCookieImportSummary,
  BrowserSessionProfile
} from '../../../../../../shared/browser/workspaces/browser-workspace-types'
import { Button } from '../../../ui/button'
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
} from '../../../ui/dropdown-menu'
import { Tooltip, TooltipContent, TooltipTrigger } from '../../../ui/tooltip'
import { useConfirmationDialog } from '../../../dismiss/confirmation/confirmation-dialog-context'
import { BrowserCookieImportDisclosure } from './BrowserCookieImportDisclosure'
import { BrowserCookieImportMachineNotice } from './BrowserCookieImportMachineNotice'
import { useAppStore } from '../../../../store/index'
import '../../../../../../shared/orca-profiles/constants'
import {
  browserCookieImportSourceLabel,
  browserCookieRefreshSource,
  refreshBrowserProfileCookies
} from '@/lib/browser/cookies/browser-cookie-refresh'
import { useTranslate } from '@/i18n/use-translate'
import { browserCookieImportFailureText } from '@/lib/browser/cookies/browser-cookie-import-error-copy'
import { translateBrowserSessionProfileLabel } from '@/lib/browser/profiles/browser-session-profile-label'

type DetectedBrowser = {
  family: string
  label: string
  profiles: { name: string; directory: string }[]
  selectedProfile: string
}

export type BrowserProfileRowProps = {
  profile: BrowserSessionProfile
  detectedBrowsers: DetectedBrowser[]
  importState: {
    profileId: string
    status: 'idle' | 'importing' | 'success' | 'error'
    summary: BrowserCookieImportSummary | null
    error: string | null
  } | null
  isActive: boolean
  onSelect: () => void
  isDefault?: boolean
}

export function BrowserProfileRow({
  profile,
  detectedBrowsers,
  importState,
  isActive,
  onSelect,
  isDefault
}: BrowserProfileRowProps): React.JSX.Element {
  const t = useTranslate()
  const isImporting = importState?.profileId === profile.id && importState.status === 'importing'
  const fetchDetectedBrowsers = useAppStore((s) => s.fetchDetectedBrowsers)
  const confirm = useConfirmationDialog()
  const [importMenuOpen, setImportMenuOpen] = useState(false)
  const refreshSource = browserCookieRefreshSource(profile.source)

  const openImportMenu = (open: boolean): void => {
    setImportMenuOpen(open)
    if (open) {
      // Probe profile folders only when import opens; macOS treats them as protected app data.
      void fetchDetectedBrowsers()
    }
  }

  const handleRefresh = async (): Promise<void> => {
    if (!refreshSource) {
      return
    }
    if ((await refreshBrowserProfileCookies(profile, refreshSource)) === 'sourceUnavailable') {
      openImportMenu(true)
    }
  }

  const handleImportFromBrowser = async (
    browserFamily: string,
    browserProfile?: string
  ): Promise<void> => {
    const result = await useAppStore
      .getState()
      .importCookiesFromBrowser(profile.id, browserFamily, browserProfile)
    if (result.ok) {
      const browser = detectedBrowsers.find((b) => b.family === browserFamily)
      emitBrowserCookieImportToast(
        result.summary,
        browserProfile
          ? t(
              'auto.components.settings.BrowserProfileRow.a3f8c2d1e0b4',
              'Imported {{value0}} cookies from {{value1}} ({{value2}}) into {{value3}}.',
              {
                value0: result.summary.importedCookies,
                value1: browser?.label ?? browserFamily,
                value2: browserProfile,
                value3: translateBrowserSessionProfileLabel(profile.label, profile.id)
              }
            )
          : t(
              'auto.components.settings.BrowserProfileRow.b4e9d3f2a1c5',
              'Imported {{value0}} cookies from {{value1}} into {{value2}}.',
              {
                value0: result.summary.importedCookies,
                value1: browser?.label ?? browserFamily,
                value2: translateBrowserSessionProfileLabel(profile.label, profile.id)
              }
            ),
        result
      )
    } else {
      toast.error(browserCookieImportFailureText(result))
    }
  }

  const handleImportFromFile = async (): Promise<void> => {
    const result = await useAppStore.getState().importCookiesToProfile(profile.id)
    if (result.ok) {
      emitBrowserCookieImportToast(
        result.summary,
        t(
          'auto.components.settings.BrowserProfileRow.b4c167764d',
          'Imported {{value0}} cookies from file into {{value1}}.',
          {
            value0: result.summary.importedCookies,
            value1: translateBrowserSessionProfileLabel(profile.label, profile.id)
          }
        ),
        result
      )
    } else if (result.reason !== 'canceled') {
      toast.error(browserCookieImportFailureText(result))
    }
  }

  const clearDefaultCookiesLabel = t(
    'auto.components.settings.BrowserProfileRow.4054c458e1',
    'Clear default cookies'
  )

  const handleClearDefaultCookies = async (): Promise<void> => {
    const confirmed = await confirm({
      title: t(
        'auto.components.settings.BrowserProfileRow.3b662becd5',
        'Clear cookies in the Default profile?'
      ),
      description: t(
        'auto.components.settings.BrowserProfileRow.f159cf5a3e',
        'This may sign you out of sites in this profile.'
      ),
      confirmLabel: t('browser.googleCookieClear.clear', 'Clear'),
      confirmVariant: 'destructive'
    })
    if (!confirmed) {
      return
    }
    const ok = await useAppStore.getState().clearDefaultSessionCookies()
    if (ok) {
      toast.success(
        t('auto.components.settings.BrowserProfileRow.2d4bea7f35', 'Default cookies cleared.')
      )
    }
  }

  const sourceLabel = profile.source
    ? browserCookieImportSourceLabel(profile.source)
    : t('auto.components.settings.BrowserProfileRow.796d846483', 'No cookies imported')

  const refreshLabel = refreshSource
    ? t('browser.cookieImport.refresh.action', 'Refresh from {{value0}}', {
        value0: refreshSource.label
      })
    : ''

  // Use role=button because nested dropdown/trash buttons make a native button invalid and trigger hydration warnings.
  return (
    <div
      role="button"
      tabIndex={0}
      onClick={onSelect}
      onKeyDown={(e) => {
        if (e.key === 'Enter' || e.key === ' ') {
          e.preventDefault()
          onSelect()
        }
      }}
      className={`flex w-full items-center gap-3 rounded-md border px-3 py-2.5 text-left transition-colors cursor-pointer ${
        isActive
          ? 'border-foreground/20 bg-accent/15'
          : 'border-border/70 hover:border-border hover:bg-accent/8'
      }`}
    >
      <div className="min-w-0 flex-1">
        <div className="flex items-center gap-2">
          <span className="truncate text-sm font-medium">
            {translateBrowserSessionProfileLabel(profile.label, profile.id)}
          </span>
          {isActive ? (
            <span className="shrink-0 rounded border border-border/50 px-1.5 text-[10px] font-medium leading-4 text-foreground/80">
              {t('auto.components.settings.BrowserProfileRow.c29648fe5b', 'Active')}
            </span>
          ) : null}
        </div>
        <p className="truncate text-[11px] text-muted-foreground">{sourceLabel}</p>
      </div>
      <div className="flex shrink-0 items-center gap-1" onClick={(e) => e.stopPropagation()}>
        {refreshSource ? (
          <Tooltip>
            <TooltipTrigger asChild>
              <Button
                variant="muted-field-icon"
                size="icon"
                className="size-7"
                aria-label={refreshLabel}
                disabled={isImporting}
                onClick={() => void handleRefresh()}
              >
                <RefreshCw className="size-3" />
              </Button>
            </TooltipTrigger>
            <TooltipContent side="top" sideOffset={4}>
              {refreshLabel}
            </TooltipContent>
          </Tooltip>
        ) : null}
        <DropdownMenu open={importMenuOpen} onOpenChange={openImportMenu}>
          <DropdownMenuTrigger asChild>
            <Button
              variant="ghost"
              size="xs"
              className="h-6 gap-1 px-1.5 text-[11px] text-muted-foreground"
              disabled={isImporting}
            >
              {isImporting ? (
                <Loader2 className="size-3 animate-spin" />
              ) : (
                <Import className="size-3" />
              )}
              {t('auto.components.settings.BrowserProfileRow.80bffd32bf', 'Import cookies')}
            </Button>
          </DropdownMenuTrigger>
          <DropdownMenuContent align="end">
            <BrowserCookieImportMachineNotice />
            {detectedBrowsers.map((browser) =>
              browser.profiles.length > 1 ? (
                <DropdownMenuSub key={browser.family}>
                  <DropdownMenuSubTrigger>
                    {t('auto.components.settings.BrowserProfileRow.c5a273a809', 'From {{value0}}', {
                      value0: browser.label
                    })}
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
                  {t('auto.components.settings.BrowserProfileRow.c5a273a809', 'From {{value0}}', {
                    value0: browser.label
                  })}
                </DropdownMenuItem>
              )
            )}
            {detectedBrowsers.length > 0 && <DropdownMenuSeparator />}
            <DropdownMenuItem onSelect={() => void handleImportFromFile()}>
              {t('auto.components.settings.BrowserProfileRow.bd7d68f138', 'From file…')}
            </DropdownMenuItem>
            <BrowserCookieImportDisclosure />
          </DropdownMenuContent>
        </DropdownMenu>
        {isDefault ? (
          <Tooltip>
            <TooltipTrigger asChild>
              <Button
                variant="ghost"
                size="icon"
                className="size-7 text-muted-foreground hover:text-destructive"
                aria-label={clearDefaultCookiesLabel}
                onClick={() => void handleClearDefaultCookies()}
              >
                <Trash2 className="size-3" />
              </Button>
            </TooltipTrigger>
            <TooltipContent side="top" sideOffset={4}>
              {clearDefaultCookiesLabel}
            </TooltipContent>
          </Tooltip>
        ) : (
          <Button
            variant="ghost"
            size="icon"
            className="size-7 text-muted-foreground hover:text-destructive"
            onClick={async () => {
              const ok = await useAppStore.getState().deleteBrowserSessionProfile(profile.id)
              if (ok) {
                toast.success(
                  t(
                    'auto.components.settings.BrowserProfileRow.8e636cae25',
                    'Profile "{{value0}}" removed.',
                    { value0: translateBrowserSessionProfileLabel(profile.label, profile.id) }
                  )
                )
              }
            }}
          >
            <Trash2 className="size-3" />
          </Button>
        )}
      </div>
    </div>
  )
}
