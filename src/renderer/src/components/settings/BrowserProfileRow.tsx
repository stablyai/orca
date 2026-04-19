import { Import, Loader2, Trash2 } from 'lucide-react'
import { toast } from 'sonner'
import type { BrowserCookieImportSummary, BrowserSessionProfile } from '../../../../shared/types'
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
import { BROWSER_FAMILY_LABELS } from '../../../../shared/constants'

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
  const isImporting = importState?.profileId === profile.id && importState.status === 'importing'

  const handleImportFromBrowser = async (
    browserFamily: string,
    browserProfile?: string
  ): Promise<void> => {
    const result = await useAppStore
      .getState()
      .importCookiesFromBrowser(profile.id, browserFamily, browserProfile)
    if (result.ok) {
      const browser = detectedBrowsers.find((b) => b.family === browserFamily)
      toast.success(
        `Imported ${result.summary.importedCookies} cookies from ${browser?.label ?? browserFamily}${browserProfile ? ` (${browserProfile})` : ''} into ${profile.label}.`
      )
    } else {
      toast.error(result.reason)
    }
  }

  const handleImportFromFile = async (): Promise<void> => {
    const result = await useAppStore.getState().importCookiesToProfile(profile.id)
    if (result.ok) {
      toast.success(
        `Imported ${result.summary.importedCookies} cookies from file into ${profile.label}.`
      )
    } else if (result.reason !== 'canceled') {
      toast.error(result.reason)
    }
  }

  const sourceLabel = profile.source
    ? `${BROWSER_FAMILY_LABELS[profile.source.browserFamily] ?? profile.source.browserFamily}${profile.source.profileName ? ` (${profile.source.profileName})` : ''}`
    : null

  return (
    <button
      type="button"
      onClick={onSelect}
      className={`flex w-full items-center gap-3 rounded-md border px-3 py-2.5 text-left transition-colors ${
        isActive
          ? 'border-foreground/20 bg-accent/15'
          : 'border-border/70 hover:border-border hover:bg-accent/8'
      }`}
    >
      <div className="min-w-0 flex-1">
        <div className="flex items-center gap-2">
          <span className="truncate text-sm font-medium">{profile.label}</span>
          {isActive ? (
            <span className="shrink-0 rounded border border-border/50 px-1.5 text-[10px] font-medium leading-4 text-foreground/80">
              Active
            </span>
          ) : null}
        </div>
        {sourceLabel ? (
          <p className="truncate text-[11px] text-muted-foreground">{sourceLabel}</p>
        ) : (
          <p className="text-[11px] text-muted-foreground">No cookies imported</p>
        )}
      </div>
      <div className="flex shrink-0 items-center gap-1" onClick={(e) => e.stopPropagation()}>
        <DropdownMenu>
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
              Import Cookies
            </Button>
          </DropdownMenuTrigger>
          <DropdownMenuContent align="end">
            {detectedBrowsers.map((browser) =>
              browser.profiles.length > 1 ? (
                <DropdownMenuSub key={browser.family}>
                  <DropdownMenuSubTrigger>From {browser.label}</DropdownMenuSubTrigger>
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
                  From {browser.label}
                </DropdownMenuItem>
              )
            )}
            {detectedBrowsers.length > 0 && <DropdownMenuSeparator />}
            <DropdownMenuItem onSelect={() => void handleImportFromFile()}>
              From File…
            </DropdownMenuItem>
          </DropdownMenuContent>
        </DropdownMenu>
        {isDefault ? (
          <Button
            variant="ghost"
            size="icon"
            className="size-7 text-muted-foreground hover:text-destructive"
            disabled={!profile.source}
            onClick={async () => {
              const ok = await useAppStore.getState().clearDefaultSessionCookies()
              if (ok) {
                toast.success('Default cookies cleared.')
              }
            }}
          >
            <Trash2 className="size-3" />
          </Button>
        ) : (
          <Button
            variant="ghost"
            size="icon"
            className="size-7 text-muted-foreground hover:text-destructive"
            onClick={async () => {
              const ok = await useAppStore.getState().deleteBrowserSessionProfile(profile.id)
              if (ok) {
                toast.success(`Profile "${profile.label}" removed.`)
              }
            }}
          >
            <Trash2 className="size-3" />
          </Button>
        )}
      </div>
    </button>
  )
}
