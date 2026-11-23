import { Check, Plus, RefreshCw, UserRound } from 'lucide-react'
import {
  DropdownMenuItem,
  DropdownMenuPortal,
  DropdownMenuSeparator,
  DropdownMenuSub,
  DropdownMenuSubContent,
  DropdownMenuSubTrigger
} from '@/components/ui/dropdown-menu'
import { useAppStore } from '@/store'
import { LOCAL_EXECUTION_HOST_ID } from '../../../../../../shared/execution-host/execution-host'
import { refreshChromeProfileCookies } from '@/lib/browser/cookies/refresh-chrome-profile-cookies'
import { useTranslate } from '@/i18n/use-translate'
import { translateBrowserSessionProfileLabel } from '@/lib/browser/profiles/browser-session-profile-label'
import { BROWSER_FAMILY_LABELS } from '../../../../../../shared/browser/browser-family-labels'
import type { BrowserSessionProfile } from '../../../../../../shared/browser/workspaces/browser-workspace-types'

export type BrowserToolbarProfileSubProps = {
  browserPageId: string
  allProfiles: BrowserSessionProfile[]
  effectiveProfileId: string
  canRefreshFromChrome: boolean
  onSwitchProfile: (profileId: string | null) => void
  onNewProfile: () => void
  /** Set while a switch is in flight; the host refuses a second one meanwhile. */
  switching?: boolean
}

/** Which profile the page's browsing session uses. Cookie import has its own top-level row. */
export function BrowserToolbarProfileSub({
  browserPageId,
  allProfiles,
  effectiveProfileId,
  canRefreshFromChrome,
  onSwitchProfile,
  onNewProfile,
  switching = false
}: BrowserToolbarProfileSubProps): React.JSX.Element {
  const t = useTranslate()
  const currentProfile = allProfiles.find((profile) => profile.id === effectiveProfileId)
  const isImporting = useAppStore((s) => {
    const pending = s.browserSessionImportStateByHostId?.[LOCAL_EXECUTION_HOST_ID]
    return pending?.profileId === effectiveProfileId && pending.status === 'importing'
  })
  return (
    <DropdownMenuSub>
      <DropdownMenuSubTrigger disabled={switching}>
        <UserRound className="size-3.5" />
        {t('browser.toolbar.profile', 'Profile')}
        <span className="ml-auto truncate pl-2 text-xs text-muted-foreground">
          {translateBrowserSessionProfileLabel(currentProfile?.label, effectiveProfileId)}
        </span>
      </DropdownMenuSubTrigger>
      <DropdownMenuPortal>
        <DropdownMenuSubContent className="w-56" data-browser-page-menu-id={browserPageId}>
          {allProfiles.map((profile) => {
            const isSelectedProfile = profile.id === effectiveProfileId
            return (
              <DropdownMenuItem
                key={profile.id}
                onSelect={() => onSwitchProfile(profile.id === 'default' ? null : profile.id)}
              >
                <Check
                  className={`size-3.5 shrink-0 ${isSelectedProfile ? 'opacity-100' : 'opacity-0'}`}
                />
                <span className="truncate">
                  {translateBrowserSessionProfileLabel(profile.label, profile.id)}
                </span>
                {profile.source?.browserFamily && (
                  <span className="ml-auto pl-2 text-2xs text-muted-foreground">
                    {BROWSER_FAMILY_LABELS[profile.source.browserFamily] ??
                      profile.source.browserFamily}
                  </span>
                )}
              </DropdownMenuItem>
            )
          })}
          <DropdownMenuSeparator />
          <DropdownMenuItem onSelect={onNewProfile}>
            <Plus className="size-3.5" />
            {t('auto.components.browser.pane.BrowserToolbarMenu.cf7cdc67ef', 'New Profile…')}
          </DropdownMenuItem>
          {canRefreshFromChrome && currentProfile?.source?.chromeProfile && (
            <DropdownMenuItem
              disabled={isImporting}
              onSelect={() =>
                void refreshChromeProfileCookies(currentProfile, LOCAL_EXECUTION_HOST_ID)
              }
            >
              <RefreshCw className="size-3.5" />
              {t('browser.cookieImport.refreshChrome', 'Refresh from Chrome')}
            </DropdownMenuItem>
          )}
        </DropdownMenuSubContent>
      </DropdownMenuPortal>
    </DropdownMenuSub>
  )
}
