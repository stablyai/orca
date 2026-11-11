import { useState } from 'react'
import { Check, Import, Plus, UserRound } from 'lucide-react'
import {
  DropdownMenuItem,
  DropdownMenuPortal,
  DropdownMenuSeparator,
  DropdownMenuSub,
  DropdownMenuSubContent,
  DropdownMenuSubTrigger
} from '@/components/ui/dropdown-menu'
import { BrowserCookieImportDisclosure } from '@/components/BrowserCookieImportDisclosure'
import { BrowserCookieImportMachineNotice } from '@/components/BrowserCookieImportMachineNotice'
import { useTranslate } from '@/i18n/use-translate'
import { translateBrowserSessionProfileLabel } from '@/lib/browser-session-profile-label'
import { BROWSER_FAMILY_LABELS } from '../../../../../shared/browser/browser-family-labels'
import type { BrowserSessionProfile } from '../../../../../shared/browser-workspace-types'

export type DetectedBrowserEntry = {
  family: string
  label: string
  profiles: { name: string; directory: string }[]
  selectedProfile: string
}

export type BrowserToolbarProfileSubProps = {
  browserPageId: string
  allProfiles: BrowserSessionProfile[]
  effectiveProfileId: string
  onSwitchProfile: (profileId: string | null) => void
  onNewProfile: () => void
  detectedBrowsers: DetectedBrowserEntry[]
  onFetchDetectedBrowsers: () => void
  browserSessionImportState: { profileId: string; status: string } | null | undefined
  onImportFromBrowser: (browserFamily: string, browserProfile?: string) => void
  onImportFromFile: () => void
  /** The browser tour opens this submenu so its Import Cookies target is on screen. */
  forceOpen: boolean
}

/** Everything about the page's browsing session: which profile it uses and what it imports. */
export function BrowserToolbarProfileSub({
  browserPageId,
  allProfiles,
  effectiveProfileId,
  onSwitchProfile,
  onNewProfile,
  detectedBrowsers,
  onFetchDetectedBrowsers,
  browserSessionImportState,
  onImportFromBrowser,
  onImportFromFile,
  forceOpen
}: BrowserToolbarProfileSubProps): React.JSX.Element {
  const t = useTranslate()
  const [open, setOpen] = useState(false)
  const currentProfile = allProfiles.find((profile) => profile.id === effectiveProfileId)
  const fromBrowserLabel = (label: string): string =>
    t('auto.components.browser.pane.BrowserToolbarMenu.eb280bfb11', 'From {{value0}}', {
      value0: label
    })
  return (
    <DropdownMenuSub open={forceOpen || open} onOpenChange={setOpen}>
      <DropdownMenuSubTrigger>
        <UserRound className="mr-2 size-3.5" />
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
                  className={`mr-2 size-3.5 shrink-0 ${isSelectedProfile ? 'opacity-100' : 'opacity-0'}`}
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
            <Plus className="mr-2 size-3.5" />
            {t('auto.components.browser.pane.BrowserToolbarMenu.cf7cdc67ef', 'New Profile…')}
          </DropdownMenuItem>
          <DropdownMenuSub
            onOpenChange={(open) => {
              if (open) {
                // Defer macOS app-data profile probes until the user opens Import.
                onFetchDetectedBrowsers()
              }
            }}
          >
            <DropdownMenuSubTrigger
              disabled={
                browserSessionImportState?.profileId === effectiveProfileId &&
                browserSessionImportState.status === 'importing'
              }
              data-contextual-tour-target="browser-import-cookies-control"
            >
              <Import className="mr-2 size-3.5" />
              {t('auto.components.browser.pane.BrowserToolbarMenu.2293adf620', 'Import Cookies')}
            </DropdownMenuSubTrigger>
            <DropdownMenuPortal>
              <DropdownMenuSubContent data-browser-page-menu-id={browserPageId}>
                <BrowserCookieImportMachineNotice />
                {detectedBrowsers.map((browser) =>
                  browser.profiles.length > 1 ? (
                    <DropdownMenuSub key={browser.family}>
                      <DropdownMenuSubTrigger>
                        {fromBrowserLabel(browser.label)}
                      </DropdownMenuSubTrigger>
                      <DropdownMenuPortal>
                        <DropdownMenuSubContent data-browser-page-menu-id={browserPageId}>
                          {browser.profiles.map((profile) => (
                            <DropdownMenuItem
                              key={profile.directory}
                              onSelect={() =>
                                onImportFromBrowser(browser.family, profile.directory)
                              }
                            >
                              {profile.name}
                            </DropdownMenuItem>
                          ))}
                        </DropdownMenuSubContent>
                      </DropdownMenuPortal>
                    </DropdownMenuSub>
                  ) : (
                    <DropdownMenuItem
                      key={browser.family}
                      onSelect={() => onImportFromBrowser(browser.family)}
                    >
                      {fromBrowserLabel(browser.label)}
                    </DropdownMenuItem>
                  )
                )}
                {detectedBrowsers.length > 0 && <DropdownMenuSeparator />}
                <DropdownMenuItem onSelect={onImportFromFile}>
                  {t('auto.components.browser.pane.BrowserToolbarMenu.56f94f4ffa', 'From File…')}
                </DropdownMenuItem>
                <BrowserCookieImportDisclosure />
              </DropdownMenuSubContent>
            </DropdownMenuPortal>
          </DropdownMenuSub>
        </DropdownMenuSubContent>
      </DropdownMenuPortal>
    </DropdownMenuSub>
  )
}
