import { useMemo, useState } from 'react'
import { Copy, Pencil, Plus, Trash2 } from 'lucide-react'
import { toast } from 'sonner'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { translate } from '@/i18n/i18n'
import type { BrowserPasswordEntrySummary } from '../../../../../../shared/browser-passwords-types'
import { browserPasswordHostOf } from './browser-password-import-toast'
import type { BrowserPasswordEntryFormStart } from './BrowserPasswordEntryForm'

function authFailedToast(): void {
  toast.error(translate('settings.browser.passwords.authFailed', 'Could not confirm it was you'))
}

export function BrowserPasswordListTab({
  browserProfileId,
  entries,
  neverOrigins,
  onChanged,
  onOpenForm,
  onImportCsv
}: {
  browserProfileId: string
  entries: BrowserPasswordEntrySummary[]
  neverOrigins: string[]
  onChanged: () => void
  onOpenForm: (start: BrowserPasswordEntryFormStart) => void
  onImportCsv: () => void
}): React.JSX.Element {
  const api = window.api.browserPasswords
  const [filter, setFilter] = useState('')

  const visibleEntries = useMemo(() => {
    const query = filter.trim().toLowerCase()
    return entries
      .filter(
        (entry) =>
          !query ||
          entry.origin.toLowerCase().includes(query) ||
          entry.username.toLowerCase().includes(query)
      )
      .sort((a, b) =>
        browserPasswordHostOf(a.origin).localeCompare(browserPasswordHostOf(b.origin))
      )
  }, [entries, filter])

  // Why Touch ID before the form opens: the edit form shows the saved password.
  const edit = async (entry: BrowserPasswordEntrySummary): Promise<void> => {
    const details = await api.getEntryDetails({ browserProfileId, entryId: entry.id })
    if (!details.ok) {
      if (details.reason === 'auth-failed') {
        authFailedToast()
      }
      return
    }
    onOpenForm({
      mode: 'edit',
      entryId: entry.id,
      site: browserPasswordHostOf(entry.origin),
      username: entry.username,
      password: details.password,
      note: details.note
    })
  }

  const copy = async (entryId: string): Promise<void> => {
    const result = await api.copyPassword({ browserProfileId, entryId })
    if (result.ok) {
      toast.success(
        translate(
          'settings.browser.passwords.copied',
          'Password copied. Orca clears it from the clipboard in 2 minutes.'
        )
      )
    } else if (result.reason === 'auth-failed') {
      authFailedToast()
    }
  }

  const remove = async (entryId: string): Promise<void> => {
    if (await api.deleteEntry({ browserProfileId, entryId })) {
      onChanged()
    }
  }

  const removeNever = async (origin: string): Promise<void> => {
    if (await api.removeNever({ browserProfileId, origin })) {
      onChanged()
    }
  }

  return (
    <div className="space-y-4">
      <div className="flex items-center gap-2">
        <Input
          value={filter}
          onChange={(event) => setFilter(event.target.value)}
          placeholder={translate('settings.browser.passwords.search', 'Search passwords')}
          className="flex-1"
        />
        <Button type="button" variant="outline" onClick={() => onOpenForm({ mode: 'add' })}>
          <Plus />
          {translate('settings.browser.passwords.add', 'Add')}
        </Button>
      </div>

      {entries.length === 0 ? (
        <div className="flex items-center justify-between gap-3">
          <p className="text-sm text-muted-foreground">
            {translate(
              'settings.browser.passwords.empty',
              'Saved passwords will appear here, or bring them from another browser.'
            )}
          </p>
          <Button type="button" variant="outline" size="sm" onClick={onImportCsv}>
            {translate('settings.browser.passwords.importCsv', 'From a CSV file…')}
          </Button>
        </div>
      ) : visibleEntries.length === 0 ? (
        <p className="text-sm text-muted-foreground">
          {translate('settings.browser.passwords.noMatches', 'No saved passwords match.')}
        </p>
      ) : (
        <div className="divide-y divide-border rounded-md border border-border">
          {visibleEntries.map((entry) => (
            <div key={entry.id} className="flex items-center gap-3 px-3 py-2">
              <div className="min-w-0 flex-1">
                <div className="truncate text-sm">{browserPasswordHostOf(entry.origin)}</div>
                <div className="truncate text-xs text-muted-foreground">
                  {entry.username ||
                    translate('settings.browser.passwords.noUsername', '(no username)')}
                </div>
              </div>
              <Button
                type="button"
                variant="ghost"
                size="icon-sm"
                onClick={() => void edit(entry)}
                aria-label={translate('settings.browser.passwords.edit', 'Edit saved password')}
              >
                <Pencil />
              </Button>
              <Button
                type="button"
                variant="ghost"
                size="icon-sm"
                onClick={() => void copy(entry.id)}
                aria-label={translate('settings.browser.passwords.copy', 'Copy password')}
              >
                <Copy />
              </Button>
              <Button
                type="button"
                variant="ghost"
                size="icon-sm"
                onClick={() => void remove(entry.id)}
                aria-label={translate('settings.browser.passwords.delete', 'Delete saved password')}
              >
                <Trash2 />
              </Button>
            </div>
          ))}
        </div>
      )}

      {neverOrigins.length > 0 ? (
        <div className="space-y-2">
          <div className="text-xs font-medium text-muted-foreground">
            {translate('settings.browser.passwords.neverHeading', 'Never saved for')}
          </div>
          <div className="divide-y divide-border rounded-md border border-border">
            {neverOrigins.map((origin) => (
              <div key={origin} className="flex items-center gap-3 px-3 py-2">
                <div className="min-w-0 flex-1 truncate text-sm">
                  {browserPasswordHostOf(origin)}
                </div>
                <Button
                  type="button"
                  variant="ghost"
                  size="xs"
                  onClick={() => void removeNever(origin)}
                >
                  {translate('settings.browser.passwords.removeNever', 'Remove')}
                </Button>
              </div>
            ))}
          </div>
        </div>
      ) : null}
    </div>
  )
}
