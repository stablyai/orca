import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { KeyRound, Plus } from 'lucide-react'
import { toast } from 'sonner'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { useConfirmationDialog } from '@/components/confirmation-dialog-context'
import { translate } from '@/i18n/i18n'
import type {
  BrowserPasswordEntrySummary,
  BrowserPasswordImportResult,
  BrowserPasswordsStatus
} from '../../../../shared/browser-passwords-types'
import type { GlobalSettings } from '../../../../shared/global-settings-types'
import { SearchableSetting } from './SearchableSetting'
import { SettingsBadge, SettingsRow } from './SettingsFormControls'
import { BrowserPasswordPreferences } from './BrowserPasswordPreferences'
import {
  BrowserPasswordEntryDialog,
  type BrowserPasswordEntryFormStart
} from './BrowserPasswordEntryDialog'
import {
  BrowserPasswordImportMenu,
  type BrowserPasswordImportSource
} from './BrowserPasswordImportMenu'
import { BrowserPasswordList } from './BrowserPasswordList'
import { BrowserPasswordNeverList } from './BrowserPasswordNeverList'
import {
  browserPasswordHostOf,
  toastBrowserPasswordImportResult
} from './browser-password-import-toast'
import { getBrowserPasswordsSearchEntry } from './browser-passwords-copy'

type VaultView = {
  status: BrowserPasswordsStatus | null
  entries: BrowserPasswordEntrySummary[]
  neverOrigins: string[]
  loadedAt: number | null
}

// Below this many logins every row fits on screen, so a search field is noise.
const SEARCH_THRESHOLD = 6

type BrowserPasswordsSectionProps = {
  browserProfileId: string
  profileLabel: string
  settings: Pick<
    GlobalSettings,
    'browserPasswordsOfferToSave' | 'browserPasswordsFillRequiresReauth'
  >
  updateSettings: (updates: Partial<GlobalSettings>) => void
}

/** Saved logins for the profile picked under Session & Cookies, as Extensions does. */
export function BrowserPasswordsSection(props: BrowserPasswordsSectionProps): React.JSX.Element {
  const entry = getBrowserPasswordsSearchEntry()
  return (
    <SearchableSetting
      id="browser-passwords"
      title={entry.title}
      description={entry.description}
      keywords={entry.keywords}
      className="space-y-3 py-2"
    >
      <BrowserPasswordsProfile key={props.browserProfileId} {...props} />
    </SearchableSetting>
  )
}

function BrowserPasswordsProfile({
  browserProfileId,
  profileLabel,
  settings,
  updateSettings
}: BrowserPasswordsSectionProps): React.JSX.Element {
  const api = window.api.browserPasswords
  const confirm = useConfirmationDialog()
  const [view, setView] = useState<VaultView>({
    status: null,
    entries: [],
    neverOrigins: [],
    loadedAt: null
  })
  const [query, setQuery] = useState('')
  const [form, setForm] = useState<BrowserPasswordEntryFormStart | null>(null)
  const editRequest = useRef(0)

  const refresh = useCallback(async () => {
    const [status, entries, neverOrigins] = await Promise.all([
      api.getStatus({ browserProfileId }),
      api.list({ browserProfileId }),
      api.listNever({ browserProfileId })
    ])
    setView({
      status,
      entries: entries ?? [],
      neverOrigins: neverOrigins ?? [],
      loadedAt: Date.now()
    })
  }, [api, browserProfileId])

  useEffect(() => {
    void refresh()
  }, [refresh])

  const visibleEntries = useMemo(() => {
    const needle = query.trim().toLowerCase()
    return needle
      ? view.entries.filter(
          (item) =>
            item.origin.toLowerCase().includes(needle) ||
            item.username.toLowerCase().includes(needle)
        )
      : view.entries
  }, [view.entries, query])

  const runImport = async (run: () => Promise<BrowserPasswordImportResult>): Promise<void> => {
    toastBrowserPasswordImportResult(await run())
    await refresh()
  }
  const importCsv = (): void => void runImport(() => api.importCsv({ browserProfileId }))
  const importBrowser = (source: BrowserPasswordImportSource): void =>
    void runImport(() => api.importFromBrowser({ browserProfileId, ...source }))

  const authFailed = (): void => {
    toast.error(translate('settings.browser.passwords.authFailed', 'Could not confirm it was you'))
  }

  const openAdd = (): void => {
    editRequest.current += 1
    setForm({ mode: 'add' })
  }

  // Why Touch ID before the dialog opens: the edit form shows the saved password.
  const edit = async (item: BrowserPasswordEntrySummary): Promise<void> => {
    const request = ++editRequest.current
    const details = await api.getEntryDetails({ browserProfileId, entryId: item.id })
    if (request !== editRequest.current) {
      return
    }
    if (!details.ok) {
      if (details.reason === 'auth-failed') {
        authFailed()
      }
      return
    }
    setForm({
      mode: 'edit',
      entryId: item.id,
      site: browserPasswordHostOf(item.origin),
      username: item.username,
      password: details.password,
      note: details.note
    })
  }

  const copy = async (item: BrowserPasswordEntrySummary): Promise<void> => {
    const result = await api.copyPassword({ browserProfileId, entryId: item.id })
    if (result.ok) {
      toast.success(
        translate(
          'settings.browser.passwords.copied',
          'Password copied. Orca clears it from the clipboard in 2 minutes.'
        )
      )
    } else if (result.reason === 'auth-failed') {
      authFailed()
    }
  }

  const remove = async (item: BrowserPasswordEntrySummary): Promise<void> => {
    const confirmed = await confirm({
      title: translate(
        'settings.browser.passwords.deleteConfirmTitle',
        'Delete the {{site}} password for {{username}}?',
        {
          site: browserPasswordHostOf(item.origin),
          username:
            item.username || translate('settings.browser.passwords.noUsername', '(no username)')
        }
      ),
      description: translate(
        'settings.browser.passwords.deleteConfirmDescription',
        'Orca won’t fill it anymore. This can’t be undone.'
      ),
      confirmLabel: translate('settings.browser.passwords.deleteConfirm', 'Delete'),
      confirmVariant: 'destructive'
    })
    if (confirmed && (await api.deleteEntry({ browserProfileId, entryId: item.id }))) {
      await refresh()
    }
  }

  const removeNever = async (origin: string): Promise<void> => {
    if (await api.removeNever({ browserProfileId, origin })) {
      await refresh()
    }
  }

  const deleteAll = async (): Promise<void> => {
    const confirmed = await confirm({
      title: translate(
        'settings.browser.passwords.deleteAllConfirmTitle',
        'Delete all password data?'
      ),
      description: translate(
        'settings.browser.passwords.deleteAllConfirmDescription',
        'Every saved password in the {{profile}} profile is permanently deleted. This can’t be undone.',
        { profile: profileLabel }
      ),
      confirmLabel: translate('settings.browser.passwords.deleteAll', 'Delete data'),
      confirmVariant: 'destructive'
    })
    if (confirmed && (await api.deleteAll({ browserProfileId }))) {
      toast.success(translate('settings.browser.passwords.deletedAll', 'Password data deleted'))
      await refresh()
    }
  }

  const unavailableReason =
    view.status && !view.status.availability.available ? view.status.availability.reason : null
  const ready = view.loadedAt !== null && !unavailableReason
  const actionsDisabled = !ready || view.status === null

  return (
    <>
      <div className="flex items-center justify-between gap-3">
        <div className="min-w-0 space-y-0.5">
          <div className="flex items-center gap-2">
            <Label>{getBrowserPasswordsSearchEntry().title}</Label>
            <SettingsBadge tone="muted">
              {translate('settings.browser.passwords.experimental', 'Experimental')}
            </SettingsBadge>
          </div>
          <p className="text-xs text-muted-foreground">
            {translate(
              'settings.browser.passwords.profileDescription',
              'Saved logins for the {{profile}} profile. Orca fills one only when you pick it under a sign-in field.',
              { profile: profileLabel }
            )}
          </p>
        </div>
        <div className="flex shrink-0 items-center gap-2">
          <BrowserPasswordImportMenu
            disabled={actionsDisabled}
            onImportCsv={importCsv}
            onImportBrowser={importBrowser}
          />
          <Button
            type="button"
            variant="outline"
            size="xs"
            disabled={actionsDisabled}
            onClick={openAdd}
          >
            <Plus />
            {translate('settings.browser.passwords.add', 'Add')}
          </Button>
        </div>
      </div>

      {unavailableReason ? (
        <div className="rounded-md border border-destructive/30 bg-destructive/5 px-3 py-2.5">
          <p className="text-sm">
            {translate(
              'settings.browser.passwords.unavailableTitle',
              'Saved passwords are off on this computer'
            )}
          </p>
          <p className="text-xs text-muted-foreground">{unavailableReason}</p>
        </div>
      ) : null}

      <BrowserPasswordPreferences
        settings={settings}
        updateSettings={updateSettings}
        canReauth={view.status?.reauthMethod === 'touch-id'}
      />

      {ready && view.entries.length === 0 ? (
        <div className="flex flex-col items-center gap-3 rounded-lg border border-dashed border-border/60 bg-card/30 px-4 py-6 text-center">
          <KeyRound className="size-5 text-muted-foreground/60" />
          <div className="space-y-1">
            <p className="text-sm">
              {translate('settings.browser.passwords.emptyTitle', 'No saved passwords yet')}
            </p>
            <p className="text-xs text-muted-foreground">
              {translate(
                'settings.browser.passwords.empty',
                'Orca offers to save a login after you sign in. You can also bring them from another browser or a CSV file.'
              )}
            </p>
          </div>
        </div>
      ) : null}

      {ready && view.entries.length > 0 ? (
        <div className="space-y-2">
          {view.entries.length > SEARCH_THRESHOLD ? (
            <Input
              value={query}
              onChange={(event) => setQuery(event.target.value)}
              placeholder={translate(
                'settings.browser.passwords.search',
                'Search {{count}} passwords',
                { count: view.entries.length }
              )}
              aria-label={translate('settings.browser.passwords.searchLabel', 'Search passwords')}
              density="compact"
            />
          ) : null}
          {visibleEntries.length > 0 ? (
            <BrowserPasswordList
              entries={visibleEntries}
              now={view.loadedAt ?? 0}
              actions={{
                onCopy: (item) => void copy(item),
                onEdit: (item) => void edit(item),
                onDelete: (item) => void remove(item)
              }}
            />
          ) : (
            <p className="py-4 text-center text-xs text-muted-foreground">
              {translate('settings.browser.passwords.noMatches', 'No saved passwords match.')}
            </p>
          )}
        </div>
      ) : null}

      {ready ? (
        <BrowserPasswordNeverList
          origins={view.neverOrigins}
          onRemove={(origin) => void removeNever(origin)}
        />
      ) : null}

      {ready ? (
        <SettingsRow
          className="border-t border-border/50"
          label={translate('settings.browser.passwords.deleteAllTitle', 'Delete all password data')}
          description={translate(
            'settings.browser.passwords.deleteAllDescription',
            'Every saved password, note and never-save site in the {{profile}} profile.',
            { profile: profileLabel }
          )}
          control={
            <Button type="button" variant="destructive" size="xs" onClick={() => void deleteAll()}>
              {translate('settings.browser.passwords.deleteAllAction', 'Delete…')}
            </Button>
          }
        />
      ) : null}

      <BrowserPasswordEntryDialog
        browserProfileId={browserProfileId}
        start={form}
        onDone={(saved) => {
          setForm(null)
          if (saved) {
            void refresh()
          }
        }}
      />
    </>
  )
}
