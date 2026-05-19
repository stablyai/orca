import { useEffect, useState } from 'react'
import { Plus } from 'lucide-react'
import { toast } from 'sonner'
import type { GlobalSettings } from '../../../../shared/types'
import { Button } from '../ui/button'
import { Input } from '../ui/input'
import { Label } from '../ui/label'
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '../ui/select'
import { Dialog, DialogContent, DialogFooter, DialogHeader, DialogTitle } from '../ui/dialog'
import { useAppStore } from '../../store'
import { ORCA_BROWSER_BLANK_URL } from '../../../../shared/constants'
import {
  normalizeBrowserNavigationUrl,
  SEARCH_ENGINE_LABELS,
  type SearchEngine
} from '../../../../shared/browser-url'
import { SearchableSetting } from './SearchableSetting'
import { matchesSettingsSearch } from './settings-search'
import { BROWSER_PANE_SEARCH_ENTRIES as BROWSER_CORE_SEARCH_ENTRIES } from './browser-search'
import { BROWSER_USE_PANE_SEARCH_ENTRIES } from './browser-use-search'
import { BrowserProfileRow } from './BrowserProfileRow'
import { BrowserUseSetup } from './BrowserUsePane'
import { KagiSessionLinkForm } from './KagiSessionLinkForm'

export const BROWSER_PANE_SEARCH_ENTRIES = [
  ...BROWSER_USE_PANE_SEARCH_ENTRIES,
  ...BROWSER_CORE_SEARCH_ENTRIES
]

type BrowserPaneProps = {
  settings: GlobalSettings
  updateSettings: (updates: Partial<GlobalSettings>) => void
  onOpenComputerUse?: () => void
}

export function BrowserPane({
  settings,
  updateSettings,
  onOpenComputerUse
}: BrowserPaneProps): React.JSX.Element {
  const searchQuery = useAppStore((s) => s.settingsSearchQuery)
  const browserDefaultUrl = useAppStore((s) => s.browserDefaultUrl)
  const setBrowserDefaultUrl = useAppStore((s) => s.setBrowserDefaultUrl)
  const browserDefaultSearchEngine = useAppStore((s) => s.browserDefaultSearchEngine)
  const setBrowserDefaultSearchEngine = useAppStore((s) => s.setBrowserDefaultSearchEngine)
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

  const selectedSearchEngine = browserDefaultSearchEngine ?? 'google'

  const showHomePage = matchesSettingsSearch(searchQuery, [BROWSER_CORE_SEARCH_ENTRIES[0]])
  const showSearchEngine = matchesSettingsSearch(searchQuery, [BROWSER_CORE_SEARCH_ENTRIES[1]])
  const showLinkRouting = matchesSettingsSearch(searchQuery, [BROWSER_CORE_SEARCH_ENTRIES[2]])
  const showCookies = matchesSettingsSearch(searchQuery, [BROWSER_CORE_SEARCH_ENTRIES[3]])
  const showBrowserUse = matchesSettingsSearch(searchQuery, BROWSER_USE_PANE_SEARCH_ENTRIES)

  const scrollToSessionCookies = (): void => {
    // Why: the "Session & Cookies" block is search-gated, so if the user has
    // filtered to a query that excludes it the target element won't be in the
    // DOM. Clear the search first, then scroll on the next frame so the block
    // has mounted.
    useAppStore.getState().setSettingsSearchQuery('')
    // Why: double RAF to ensure React has committed the re-render triggered by
    // the store update before we query the DOM — a single RAF can fire before
    // commit and miss the newly-mounted element.
    requestAnimationFrame(() => {
      requestAnimationFrame(() => {
        const el = document.getElementById('browser-session-cookies')
        if (!el) {
          return
        }
        el.scrollIntoView({ behavior: 'smooth', block: 'start' })
      })
    })
  }

  return (
    <div className="space-y-6">
      {showBrowserUse ? (
        <BrowserUseSetup
          onConfigureMoreBrowsers={scrollToSessionCookies}
          onOpenComputerUse={onOpenComputerUse}
        />
      ) : null}

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

      {showSearchEngine ? (
        <SearchableSetting
          title="Default Search Engine"
          description="Search engine used when typing non-URL text in the address bar."
          keywords={[
            'browser',
            'search',
            'engine',
            'google',
            'duckduckgo',
            'bing',
            'kagi',
            'session',
            'private',
            'token',
            'omnibox'
          ]}
          className="flex items-start justify-between gap-4 px-1 py-2"
        >
          <div className="space-y-0.5">
            <Label>Default Search Engine</Label>
            <p className="text-xs text-muted-foreground">
              Used when typing non-URL text in the address bar.
            </p>
          </div>
          <div className="flex shrink-0 flex-col items-end gap-2">
            <Select
              value={selectedSearchEngine}
              onValueChange={(value) => {
                const engine = value as SearchEngine
                setBrowserDefaultSearchEngine(engine === 'google' ? null : engine)
              }}
            >
              <SelectTrigger className="h-7 w-36 text-xs">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {(Object.keys(SEARCH_ENGINE_LABELS) as SearchEngine[]).map((engine) => (
                  <SelectItem key={engine} value={engine} className="text-xs">
                    {SEARCH_ENGINE_LABELS[engine]}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
            {selectedSearchEngine === 'kagi' ? <KagiSessionLinkForm /> : null}
          </div>
        </SearchableSetting>
      ) : null}

      {showLinkRouting ? (
        <SearchableSetting
          title="Link Routing"
          description="Open http(s) links in Orca's built-in browser — from the terminal, markdown, and the editor. Shift+Cmd/Ctrl+click always uses your system browser."
          keywords={[
            'browser',
            'preview',
            'links',
            'localhost',
            'webview',
            'markdown',
            'file',
            'editor'
          ]}
          className="flex items-center justify-between gap-4 px-1 py-2"
        >
          <div className="space-y-0.5">
            <Label>Link Routing</Label>
            <p className="text-xs text-muted-foreground">
              Open http(s) links in Orca&apos;s built-in browser — from the terminal, markdown, and
              the editor. Shift+Cmd/Ctrl+click always uses your system browser.
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
          id="browser-session-cookies"
          title="Session & Cookies"
          description="Manage browser profiles and import cookies from Chrome, Edge, Comet, or other browsers."
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
