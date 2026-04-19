import { useEffect, useState } from 'react'
import { Plus } from 'lucide-react'
import { toast } from 'sonner'
import type { GlobalSettings } from '../../../../shared/types'
import { Button } from '../ui/button'
import { Input } from '../ui/input'
import { Label } from '../ui/label'
import { Dialog, DialogContent, DialogFooter, DialogHeader, DialogTitle } from '../ui/dialog'
import { useAppStore } from '../../store'
import { ORCA_BROWSER_BLANK_URL } from '../../../../shared/constants'
import { normalizeBrowserNavigationUrl } from '../../../../shared/browser-url'
import { SearchableSetting } from './SearchableSetting'
import { matchesSettingsSearch } from './settings-search'
import { BROWSER_PANE_SEARCH_ENTRIES } from './browser-search'
import { BrowserProfileRow } from './BrowserProfileRow'

export { BROWSER_PANE_SEARCH_ENTRIES }

type BrowserPaneProps = {
  settings: GlobalSettings
  updateSettings: (updates: Partial<GlobalSettings>) => void
}

export function BrowserPane({ settings, updateSettings }: BrowserPaneProps): React.JSX.Element {
  const searchQuery = useAppStore((s) => s.settingsSearchQuery)
  const browserDefaultUrl = useAppStore((s) => s.browserDefaultUrl)
  const setBrowserDefaultUrl = useAppStore((s) => s.setBrowserDefaultUrl)
  const browserSessionProfiles = useAppStore((s) => s.browserSessionProfiles)
  const detectedBrowsers = useAppStore((s) => s.detectedBrowsers)
  const browserSessionImportState = useAppStore((s) => s.browserSessionImportState)
  const defaultBrowserSessionProfileId = useAppStore((s) => s.defaultBrowserSessionProfileId)
  const setDefaultBrowserSessionProfileId = useAppStore((s) => s.setDefaultBrowserSessionProfileId)
  const defaultProfile = browserSessionProfiles.find((p) => p.id === 'default')
  const nonDefaultProfiles = browserSessionProfiles.filter((p) => p.scope !== 'default')
  const [homePageDraft, setHomePageDraft] = useState(browserDefaultUrl ?? '')
  const [newProfileDialogOpen, setNewProfileDialogOpen] = useState(false)
  const [newProfileName, setNewProfileName] = useState('')
  const [isCreatingProfile, setIsCreatingProfile] = useState(false)

  // Why: sync draft with store value whenever it changes externally (e.g. the
  // in-app browser tab's address bar saves a home page). Without this, the
  // settings field would show stale text after another surface wrote the value.
  useEffect(() => {
    setHomePageDraft(browserDefaultUrl ?? '')
  }, [browserDefaultUrl])

  const showHomePage = matchesSettingsSearch(searchQuery, [BROWSER_PANE_SEARCH_ENTRIES[0]])
  const showLinkRouting = matchesSettingsSearch(searchQuery, [BROWSER_PANE_SEARCH_ENTRIES[1]])
  const showCookies = matchesSettingsSearch(searchQuery, [BROWSER_PANE_SEARCH_ENTRIES[2]])

  return (
    <div className="space-y-4">
      {showHomePage ? (
        <SearchableSetting
          title="Default Home Page"
          description="URL opened when creating a new browser tab. Leave empty to open a blank tab."
          keywords={['browser', 'home', 'homepage', 'default', 'url', 'new tab', 'blank']}
          className="flex items-start justify-between gap-4 px-1 py-2"
        >
          <div className="min-w-0 shrink space-y-0.5">
            <Label>Default Home Page</Label>
            <p className="text-xs text-muted-foreground">
              URL opened when creating a new browser tab. Leave empty to open a blank tab.
            </p>
          </div>
          <form
            className="flex shrink-0 items-center gap-2"
            onSubmit={(e) => {
              e.preventDefault()
              const trimmed = homePageDraft.trim()
              if (!trimmed) {
                setBrowserDefaultUrl(null)
                return
              }
              const normalized = normalizeBrowserNavigationUrl(trimmed)
              if (normalized && normalized !== ORCA_BROWSER_BLANK_URL) {
                setBrowserDefaultUrl(normalized)
                setHomePageDraft(normalized)
                toast.success('Home page saved.')
              }
            }}
          >
            <Input
              value={homePageDraft}
              onChange={(e) => setHomePageDraft(e.target.value)}
              placeholder="https://google.com"
              spellCheck={false}
              autoCapitalize="none"
              autoCorrect="off"
              className="h-7 w-52 text-xs"
            />
            <Button type="submit" size="sm" variant="outline" className="h-7 text-xs">
              Save
            </Button>
          </form>
        </SearchableSetting>
      ) : null}

      {showLinkRouting ? (
        <SearchableSetting
          title="Terminal Link Routing"
          description="Cmd/Ctrl+click opens terminal http(s) links in Orca. Shift+Cmd/Ctrl+click uses the system browser."
          keywords={['browser', 'preview', 'links', 'localhost', 'webview']}
          className="flex items-center justify-between gap-4 px-1 py-2"
        >
          <div className="space-y-0.5">
            <Label>Terminal Link Routing</Label>
            <p className="text-xs text-muted-foreground">
              Cmd/Ctrl+click opens terminal links in Orca. Shift+Cmd/Ctrl+click opens the same link
              in your system browser.
            </p>
          </div>
          <button
            role="switch"
            aria-checked={settings.openLinksInApp}
            onClick={() => updateSettings({ openLinksInApp: !settings.openLinksInApp })}
            className={`relative inline-flex h-5 w-9 shrink-0 cursor-pointer items-center rounded-full border border-transparent transition-colors ${
              settings.openLinksInApp ? 'bg-foreground' : 'bg-muted-foreground/30'
            }`}
          >
            <span
              className={`inline-block h-3.5 w-3.5 transform rounded-full bg-background shadow-sm transition-transform ${
                settings.openLinksInApp ? 'translate-x-4' : 'translate-x-0.5'
              }`}
            />
          </button>
        </SearchableSetting>
      ) : null}

      {showCookies ? (
        <SearchableSetting
          title="Session & Cookies"
          description="Manage browser profiles and import cookies from Chrome, Edge, or other browsers."
          keywords={[
            'cookies',
            'session',
            'import',
            'auth',
            'login',
            'chrome',
            'edge',
            'arc',
            'profile'
          ]}
          className="space-y-3 px-1 py-2"
        >
          <div className="flex items-center justify-between gap-3">
            <div className="space-y-0.5">
              <Label>Session &amp; Cookies</Label>
              <p className="text-xs text-muted-foreground">
                Select a default profile for new browser tabs. Import cookies and switch profiles
                per-tab via the <strong>···</strong> toolbar menu.
              </p>
            </div>
            <Button
              variant="outline"
              size="xs"
              onClick={() => setNewProfileDialogOpen(true)}
              className="shrink-0 gap-1.5"
            >
              <Plus className="size-3" />
              Add Profile
            </Button>
          </div>

          <div className="space-y-2">
            <BrowserProfileRow
              profile={
                defaultProfile ?? {
                  id: 'default',
                  scope: 'default',
                  partition: '',
                  label: 'Default',
                  source: null
                }
              }
              detectedBrowsers={detectedBrowsers}
              importState={browserSessionImportState}
              isActive={(defaultBrowserSessionProfileId ?? 'default') === 'default'}
              onSelect={() => setDefaultBrowserSessionProfileId(null)}
              isDefault
            />
            {nonDefaultProfiles.map((profile) => (
              <BrowserProfileRow
                key={profile.id}
                profile={profile}
                detectedBrowsers={detectedBrowsers}
                importState={browserSessionImportState}
                isActive={(defaultBrowserSessionProfileId ?? 'default') === profile.id}
                onSelect={() => setDefaultBrowserSessionProfileId(profile.id)}
              />
            ))}
          </div>
        </SearchableSetting>
      ) : null}

      <Dialog
        open={newProfileDialogOpen}
        onOpenChange={(open) => {
          if (!open) {
            setNewProfileDialogOpen(false)
            setNewProfileName('')
          }
        }}
      >
        <DialogContent className="sm:max-w-sm" showCloseButton={false}>
          <DialogHeader>
            <DialogTitle className="text-base">New Browser Profile</DialogTitle>
          </DialogHeader>
          <form
            onSubmit={async (e) => {
              e.preventDefault()
              const trimmed = newProfileName.trim()
              if (!trimmed) {
                return
              }
              setIsCreatingProfile(true)
              try {
                const profile = await useAppStore
                  .getState()
                  .createBrowserSessionProfile('isolated', trimmed)
                if (profile) {
                  setNewProfileDialogOpen(false)
                  setNewProfileName('')
                  toast.success(`Profile "${profile.label}" created.`)
                } else {
                  toast.error('Failed to create profile.')
                }
              } finally {
                setIsCreatingProfile(false)
              }
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
    </div>
  )
}
