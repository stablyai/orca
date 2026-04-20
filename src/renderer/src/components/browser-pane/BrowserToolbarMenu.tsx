import { useState } from 'react'
import { Check, Ellipsis, Import, Plus, Settings } from 'lucide-react'
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
  DropdownMenuSeparator,
  DropdownMenuSub,
  DropdownMenuSubContent,
  DropdownMenuSubTrigger,
  DropdownMenuTrigger
} from '@/components/ui/dropdown-menu'
import { useAppStore } from '@/store'
import { BROWSER_FAMILY_LABELS } from '../../../../shared/constants'

type BrowserToolbarMenuProps = {
  currentProfileId: string | null
  workspaceId: string
  onDestroyWebview: () => void
}

export function BrowserToolbarMenu({
  currentProfileId,
  workspaceId,
  onDestroyWebview
}: BrowserToolbarMenuProps): React.JSX.Element {
  const browserSessionProfiles = useAppStore((s) => s.browserSessionProfiles)
  const detectedBrowsers = useAppStore((s) => s.detectedBrowsers)
  const switchBrowserTabProfile = useAppStore((s) => s.switchBrowserTabProfile)
  const createBrowserSessionProfile = useAppStore((s) => s.createBrowserSessionProfile)
  const importCookiesFromBrowser = useAppStore((s) => s.importCookiesFromBrowser)
  const importCookiesToProfile = useAppStore((s) => s.importCookiesToProfile)
  const browserSessionImportState = useAppStore((s) => s.browserSessionImportState)

  const [newProfileDialogOpen, setNewProfileDialogOpen] = useState(false)
  const [newProfileName, setNewProfileName] = useState('')
  const [isCreatingProfile, setIsCreatingProfile] = useState(false)
  const [pendingSwitchProfileId, setPendingSwitchProfileId] = useState<string | null | undefined>(
    undefined
  )

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
    toast.success(`Switched to ${profile?.label ?? 'Default'} profile`)
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
        toast.error('Failed to create profile.')
        return
      }

      setNewProfileDialogOpen(false)
      setNewProfileName('')

      onDestroyWebview()
      switchBrowserTabProfile(workspaceId, profile.id)
      toast.success(`Created and switched to ${profile.label} profile`)
    } finally {
      setIsCreatingProfile(false)
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
        `Imported ${result.summary.importedCookies} cookies from ${browser?.label ?? browserFamily}${browserProfile ? ` (${browserProfile})` : ''}.`
      )
    } else {
      toast.error(result.reason)
    }
  }

  const handleImportFromFile = async (): Promise<void> => {
    const result = await importCookiesToProfile(effectiveProfileId)
    if (result.ok) {
      toast.success(`Imported ${result.summary.importedCookies} cookies from file.`)
    } else if (result.reason !== 'canceled') {
      toast.error(result.reason)
    }
  }

  return (
    <>
      <DropdownMenu>
        <DropdownMenuTrigger asChild>
          <Button size="icon" variant="ghost" className="h-8 w-8" title="Browser menu">
            <Ellipsis className="size-4" />
          </Button>
        </DropdownMenuTrigger>
        <DropdownMenuContent align="end" className="w-56">
          {allProfiles.map((profile) => {
            const isActive = profile.id === effectiveProfileId
            return (
              <DropdownMenuItem
                key={profile.id}
                onSelect={() => handleSwitchProfile(profile.id === 'default' ? null : profile.id)}
              >
                <Check
                  className={`mr-2 size-3.5 shrink-0 ${isActive ? 'opacity-100' : 'opacity-0'}`}
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
            New Profile…
          </DropdownMenuItem>

          <DropdownMenuSeparator />

          <DropdownMenuSub>
            <DropdownMenuSubTrigger disabled={browserSessionImportState?.status === 'importing'}>
              <Import className="mr-2 size-3.5" />
              Import Cookies
            </DropdownMenuSubTrigger>
            <DropdownMenuPortal>
              <DropdownMenuSubContent>
                {detectedBrowsers.map((browser) =>
                  browser.profiles.length > 1 ? (
                    <DropdownMenuSub key={browser.family}>
                      <DropdownMenuSubTrigger>From {browser.label}</DropdownMenuSubTrigger>
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
                      From {browser.label}
                    </DropdownMenuItem>
                  )
                )}
                {detectedBrowsers.length > 0 && <DropdownMenuSeparator />}
                <DropdownMenuItem onSelect={() => void handleImportFromFile()}>
                  From File…
                </DropdownMenuItem>
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
            Browser Settings…
          </DropdownMenuItem>
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
            <DialogTitle className="text-base">Switch Profile</DialogTitle>
            <DialogDescription className="text-xs">
              Switching profiles will reload this page. Any unsaved form data will be lost.
            </DialogDescription>
          </DialogHeader>
          <DialogFooter>
            <Button
              variant="outline"
              size="sm"
              onClick={() => setPendingSwitchProfileId(undefined)}
            >
              Cancel
            </Button>
            <Button size="sm" onClick={confirmSwitchProfile}>
              Switch
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      <Dialog open={newProfileDialogOpen} onOpenChange={setNewProfileDialogOpen}>
        <DialogContent className="sm:max-w-sm" showCloseButton={false}>
          <DialogHeader>
            <DialogTitle className="text-base">New Browser Profile</DialogTitle>
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
              placeholder="Profile name"
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
                Cancel
              </Button>
              <Button
                type="submit"
                size="sm"
                disabled={!newProfileName.trim() || isCreatingProfile}
              >
                {isCreatingProfile ? 'Creating…' : 'Create'}
              </Button>
            </DialogFooter>
          </form>
        </DialogContent>
      </Dialog>
    </>
  )
}
