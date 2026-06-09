import { useLayoutEffect, useState } from 'react'
import { Check, Ellipsis, Import, Monitor, Plus, Settings } from 'lucide-react'
import { toast } from 'sonner'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle
} from '@/components/ui/dialog'
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuPortal,
  DropdownMenuRadioGroup,
  DropdownMenuRadioItem,
  DropdownMenuSeparator,
  DropdownMenuSub,
  DropdownMenuSubContent,
  DropdownMenuSubTrigger,
  DropdownMenuTrigger
} from '@/components/ui/dropdown-menu'
import { useAppStore } from '@/store'
import { useMountedRef } from '@/hooks/useMountedRef'
import { shouldShowBrowserImportHint } from './browser-import-hint-visibility'
import { BROWSER_FAMILY_LABELS } from '../../../../shared/constants'
import type { BrowserViewportPresetId } from '../../../../shared/types'
import {
  BROWSER_VIEWPORT_PRESETS,
  browserViewportPresetToOverride,
  getBrowserViewportPreset
} from '../../../../shared/browser-viewport-presets'
import { translate } from '@/i18n/i18n'

type BrowserToolbarMenuProps = {
  currentProfileId: string | null
  workspaceId: string
  browserPageId: string
  viewportPresetId: BrowserViewportPresetId | null
  onDestroyWebview: () => void
  isActive: boolean
}

export function BrowserToolbarMenu({
  currentProfileId,
  workspaceId,
  browserPageId,
  viewportPresetId,
  onDestroyWebview,
  isActive
}: BrowserToolbarMenuProps): React.JSX.Element {
  const browserSessionProfiles = useAppStore((s) => s.browserSessionProfiles)
  const detectedBrowsers = useAppStore((s) => s.detectedBrowsers)
  const switchBrowserTabProfile = useAppStore((s) => s.switchBrowserTabProfile)
  const createBrowserSessionProfile = useAppStore((s) => s.createBrowserSessionProfile)
  const importCookiesFromBrowser = useAppStore((s) => s.importCookiesFromBrowser)
  const importCookiesToProfile = useAppStore((s) => s.importCookiesToProfile)
  const fetchDetectedBrowsers = useAppStore((s) => s.fetchDetectedBrowsers)
  const browserSessionImportState = useAppStore((s) => s.browserSessionImportState)
  const setBrowserPageViewportPreset = useAppStore((s) => s.setBrowserPageViewportPreset)
  const browserCookieTourStepActive = useAppStore(
    (s) => s.activeContextualTourId === 'browser' && s.activeContextualTourStepIndex === 2
  )
  const browserImportHintHidden = useAppStore((s) => s.browserImportHintHidden)
  const persistedUIReady = useAppStore((s) => s.persistedUIReady)
  // The tour prefers the always-visible Import button; only force this overflow
  // menu open to expose Import Cookies once that hint button is dismissed.
  const importHintVisible = shouldShowBrowserImportHint({
    persistedUIReady,
    browserImportHintHidden
  })
  const shouldForceMenuOpen = browserCookieTourStepActive && isActive && !importHintVisible

  const applyViewportPreset = (nextId: BrowserViewportPresetId | null): void => {
    setBrowserPageViewportPreset(browserPageId, nextId)
    const preset = getBrowserViewportPreset(nextId)
    const override = preset ? browserViewportPresetToOverride(preset) : null
    void window.api.browser.setViewportOverride({ browserPageId, override })
  }

  const [newProfileDialogOpen, setNewProfileDialogOpen] = useState(false)
  const [newProfileName, setNewProfileName] = useState('')
  const [isCreatingProfile, setIsCreatingProfile] = useState(false)
  const [pendingSwitchProfileId, setPendingSwitchProfileId] = useState<string | null | undefined>(
    undefined
  )
  const [menuOpen, setMenuOpen] = useState(false)
  const mountedRef = useMountedRef()

  useLayoutEffect(() => {
    // Why: step 3 falls back to the Import Cookies row inside this menu, so open
    // it only when the tour reaches that step and the hint button is hidden.
    setMenuOpen(shouldForceMenuOpen)
  }, [shouldForceMenuOpen])

  const handleMenuOpenChange = (open: boolean): void => {
    if (shouldForceMenuOpen && !open) {
      return
    }
    setMenuOpen(open)
  }

  const effectiveProfileId = currentProfileId ?? 'default'

  const defaultProfile = browserSessionProfiles.find((p) => p.id === 'default')
  // Why: Default profile always appears first in the list and cannot be deleted.
  // Non-default profiles follow in their natural order.
  const allProfiles = defaultProfile
    ? [defaultProfile, ...browserSessionProfiles.filter((p) => p.id !== 'default')]
    : browserSessionProfiles

  const handleSwitchProfile = (profileId: string | null): void => {
    const targetId = profileId ?? 'default'
    if (targetId === effectiveProfileId) {
      return
    }
    setPendingSwitchProfileId(profileId)
  }

  const confirmSwitchProfile = (): void => {
    if (pendingSwitchProfileId === undefined) {
      return
    }
    const targetId = pendingSwitchProfileId ?? 'default'
    // Why: Must destroy before store update. The webviewRegistry is keyed by
    // workspace ID (stable across switches). Without explicit destroy, the mount
    // effect would reclaim the old webview with the stale partition.
    onDestroyWebview()
    switchBrowserTabProfile(workspaceId, pendingSwitchProfileId)
    const profile = browserSessionProfiles.find((p) => p.id === targetId)
    toast.success(translate("auto.components.browser.pane.BrowserToolbarMenu.3ccd29d771", "Switched to {{value0}} profile", { value0: profile?.label ?? 'Default' }))
    setPendingSwitchProfileId(undefined)
  }

  const handleCreateProfile = async (): Promise<void> => {
    const trimmed = newProfileName.trim()
    if (!trimmed) {
      return
    }

    setIsCreatingProfile(true)
    try {
      const profile = await createBrowserSessionProfile('isolated', trimmed)
      if (!profile) {
        if (mountedRef.current) {
          toast.error(translate("auto.components.browser.pane.BrowserToolbarMenu.4d2f9f13a7", "Failed to create profile."))
        }
        return
      }

      if (!mountedRef.current) {
        return
      }

      setNewProfileDialogOpen(false)
      setNewProfileName('')

      onDestroyWebview()
      switchBrowserTabProfile(workspaceId, profile.id)
      toast.success(translate("auto.components.browser.pane.BrowserToolbarMenu.a7a86702b3", "Created and switched to {{value0}} profile", { value0: profile.label }))
    } finally {
      if (mountedRef.current) {
        setIsCreatingProfile(false)
      }
    }
  }

  const handleImportFromBrowser = async (
    browserFamily: string,
    browserProfile?: string
  ): Promise<void> => {
    const result = await importCookiesFromBrowser(effectiveProfileId, browserFamily, browserProfile)
    if (result.ok) {
      const browser = detectedBrowsers.find((b) => b.family === browserFamily)
      toast.success(
        translate("auto.components.browser.pane.BrowserToolbarMenu.6aa42813e4", "Imported {{value0}} cookies from {{value1}}{{value2}}.", { value0: result.summary.importedCookies, value1: browser?.label ?? browserFamily, value2: browserProfile ? ` (${browserProfile})` : '' })
      )
    } else {
      toast.error(result.reason)
    }
  }

  const handleImportFromFile = async (): Promise<void> => {
    const result = await importCookiesToProfile(effectiveProfileId)
    if (result.ok) {
      toast.success(translate("auto.components.browser.pane.BrowserToolbarMenu.6aa42813e4", "Imported {{value0}} cookies from file.", { value0: result.summary.importedCookies }))
    } else if (result.reason !== 'canceled') {
      toast.error(result.reason)
    }
  }

  return (
    <>
      <DropdownMenu modal={false} open={menuOpen} onOpenChange={handleMenuOpenChange}>
        <DropdownMenuTrigger asChild>
          <Button size="icon" variant="ghost" className="h-8 w-8" title={translate("auto.components.browser.pane.BrowserToolbarMenu.7b838540c7", "Browser menu")}>
            <Ellipsis className="size-4" />
          </Button>
        </DropdownMenuTrigger>
        <DropdownMenuContent align="end" className="w-56">
          {allProfiles.map((profile) => {
            const isSelectedProfile = profile.id === effectiveProfileId
            return (
              <DropdownMenuItem
                key={profile.id}
                onSelect={() => handleSwitchProfile(profile.id === 'default' ? null : profile.id)}
              >
                <Check
                  className={`mr-2 size-3.5 shrink-0 ${isSelectedProfile ? 'opacity-100' : 'opacity-0'}`}
                />
                <span className="truncate">{profile.label}</span>
                {profile.source?.browserFamily && (
                  <span className="ml-auto pl-2 text-[10px] text-muted-foreground">
                    {BROWSER_FAMILY_LABELS[profile.source.browserFamily] ??
                      profile.source.browserFamily}
                  </span>
                )}
              </DropdownMenuItem>
            )
          })}

          <DropdownMenuSeparator />

          <DropdownMenuItem onSelect={() => setNewProfileDialogOpen(true)}>
            <Plus className="mr-2 size-3.5" />
            {translate("auto.components.browser.pane.BrowserToolbarMenu.cf7cdc67ef", "New Profile…")}</DropdownMenuItem>

          <DropdownMenuSeparator />

          <DropdownMenuSub
            onOpenChange={(open) => {
              if (open) {
                // Why: macOS treats other browsers' profile folders as app
                // data. Only probe them when the user opens the import menu.
                void fetchDetectedBrowsers()
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
              {translate("auto.components.browser.pane.BrowserToolbarMenu.2293adf620", "Import Cookies")}</DropdownMenuSubTrigger>
            <DropdownMenuPortal>
              <DropdownMenuSubContent>
                {detectedBrowsers.map((browser) =>
                  browser.profiles.length > 1 ? (
                    <DropdownMenuSub key={browser.family}>
                      <DropdownMenuSubTrigger>{translate("auto.components.browser.pane.BrowserToolbarMenu.eb280bfb11", "From")}{browser.label}</DropdownMenuSubTrigger>
                      <DropdownMenuPortal>
                        <DropdownMenuSubContent>
                          {browser.profiles.map((profile) => (
                            <DropdownMenuItem
                              key={profile.directory}
                              onSelect={() =>
                                void handleImportFromBrowser(browser.family, profile.directory)
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
                      onSelect={() => void handleImportFromBrowser(browser.family)}
                    >
                      {translate("auto.components.browser.pane.BrowserToolbarMenu.eb280bfb11", "From")}{browser.label}
                    </DropdownMenuItem>
                  )
                )}
                {detectedBrowsers.length > 0 && <DropdownMenuSeparator />}
                <DropdownMenuItem onSelect={() => void handleImportFromFile()}>
                  {translate("auto.components.browser.pane.BrowserToolbarMenu.56f94f4ffa", "From File…")}</DropdownMenuItem>
              </DropdownMenuSubContent>
            </DropdownMenuPortal>
          </DropdownMenuSub>

          <DropdownMenuSeparator />

          <DropdownMenuSub>
            <DropdownMenuSubTrigger>
              <Monitor className="mr-2 size-3.5" />
              {translate("auto.components.browser.pane.BrowserToolbarMenu.e5d31de1a9", "Viewport Size")}</DropdownMenuSubTrigger>
            <DropdownMenuPortal>
              <DropdownMenuSubContent>
                {/* Why: Viewport is a "pick one of N" control, so use a radio group
                    for proper a11y semantics (role="menuitemradio", aria-checked).
                    The "Default" option represents a null preset (no override),
                    encoded as the sentinel string 'default' because
                    DropdownMenuRadioGroup values must be strings. */}
                <DropdownMenuRadioGroup
                  value={viewportPresetId ?? 'default'}
                  onValueChange={(v) =>
                    applyViewportPreset(v === 'default' ? null : (v as BrowserViewportPresetId))
                  }
                >
                  <DropdownMenuRadioItem value="default">{translate("auto.components.browser.pane.BrowserToolbarMenu.ed8f54509d", "Default")}</DropdownMenuRadioItem>
                  <DropdownMenuSeparator />
                  {BROWSER_VIEWPORT_PRESETS.map((preset) => (
                    <DropdownMenuRadioItem key={preset.id} value={preset.id}>
                      <span className="truncate">{preset.label}</span>
                    </DropdownMenuRadioItem>
                  ))}
                </DropdownMenuRadioGroup>
              </DropdownMenuSubContent>
            </DropdownMenuPortal>
          </DropdownMenuSub>

          <DropdownMenuSeparator />

          <DropdownMenuItem
            onSelect={() => {
              useAppStore.getState().openSettingsTarget({ pane: 'browser', repoId: null })
              useAppStore.getState().openSettingsPage()
            }}
          >
            <Settings className="mr-2 size-3.5" />
            {translate("auto.components.browser.pane.BrowserToolbarMenu.a771c2b6c8", "Browser Settings…")}</DropdownMenuItem>
        </DropdownMenuContent>
      </DropdownMenu>

      <Dialog
        open={pendingSwitchProfileId !== undefined}
        onOpenChange={(open) => {
          if (!open) {
            setPendingSwitchProfileId(undefined)
          }
        }}
      >
        <DialogContent className="sm:max-w-sm" showCloseButton={false}>
          <DialogHeader>
            <DialogTitle className="text-base">{translate("auto.components.browser.pane.BrowserToolbarMenu.fe683eb3b4", "Switch Profile")}</DialogTitle>
            <DialogDescription className="text-xs">
              {translate("auto.components.browser.pane.BrowserToolbarMenu.a38f217b46", "Switching profiles will reload this page. Any unsaved form data will be lost.")}</DialogDescription>
          </DialogHeader>
          <DialogFooter>
            <Button
              variant="outline"
              size="sm"
              onClick={() => setPendingSwitchProfileId(undefined)}
            >
              {translate("auto.components.browser.pane.BrowserToolbarMenu.429ef481f9", "Cancel")}</Button>
            <Button size="sm" onClick={confirmSwitchProfile}>
              {translate("auto.components.browser.pane.BrowserToolbarMenu.58f2c81542", "Switch")}</Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      <Dialog open={newProfileDialogOpen} onOpenChange={setNewProfileDialogOpen}>
        <DialogContent className="sm:max-w-sm" showCloseButton={false}>
          <DialogHeader>
            <DialogTitle className="text-base">{translate("auto.components.browser.pane.BrowserToolbarMenu.67e9b9fcd6", "New Browser Profile")}</DialogTitle>
          </DialogHeader>
          <form
            onSubmit={(e) => {
              e.preventDefault()
              void handleCreateProfile()
            }}
          >
            <Input
              value={newProfileName}
              onChange={(e) => setNewProfileName(e.target.value)}
              placeholder={translate("auto.components.browser.pane.BrowserToolbarMenu.64f448fb6e", "Profile name")}
              autoFocus
              maxLength={50}
              className="mb-4"
            />
            <DialogFooter>
              <Button
                type="button"
                variant="outline"
                size="sm"
                onClick={() => {
                  setNewProfileDialogOpen(false)
                  setNewProfileName('')
                }}
              >
                {translate("auto.components.browser.pane.BrowserToolbarMenu.429ef481f9", "Cancel")}</Button>
              <Button
                type="submit"
                size="sm"
                disabled={!newProfileName.trim() || isCreatingProfile}
              >
                {isCreatingProfile ? translate("auto.components.browser.pane.BrowserToolbarMenu.bf648471c5", "Creating…") : translate("auto.components.browser.pane.BrowserToolbarMenu.569bce8eb1", "Create")}
              </Button>
            </DialogFooter>
          </form>
        </DialogContent>
      </Dialog>
    </>
  )
}
