import { useCallback, useEffect, useState } from 'react'
import { toast } from 'sonner'
import { Dialog, DialogContent, DialogHeader, DialogTitle } from '@/components/ui/dialog'
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue
} from '@/components/ui/select'
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs'
import { useConfirmationDialog } from '@/components/confirmation-dialog-context'
import { translate } from '@/i18n/i18n'
import type {
  BrowserPasswordEntrySummary,
  BrowserPasswordImportResult,
  BrowserPasswordsStatus
} from '../../../../../../shared/browser-passwords-types'
import type { BrowserSessionProfile } from '../../../../../../shared/browser-workspace-types'
import type { GlobalSettings } from '../../../../../../shared/global-settings-types'
import {
  BrowserPasswordAdvancedTab,
  type BrowserPasswordImportSource
} from './BrowserPasswordAdvancedTab'
import {
  BrowserPasswordEntryForm,
  type BrowserPasswordEntryFormStart
} from './BrowserPasswordEntryForm'
import { BrowserPasswordListTab } from './BrowserPasswordListTab'
import { toastBrowserPasswordImportResult } from './browser-password-import-toast'

type VaultView = {
  status: BrowserPasswordsStatus | null
  entries: BrowserPasswordEntrySummary[]
  neverOrigins: string[]
}

const EMPTY_VIEW: VaultView = { status: null, entries: [], neverOrigins: [] }

type BrowserPasswordManagerDialogProps = {
  open: boolean
  onOpenChange: (open: boolean) => void
  profiles: BrowserSessionProfile[]
  settings: Pick<
    GlobalSettings,
    'browserPasswordsOfferToSave' | 'browserPasswordsFillRequiresReauth'
  >
  updateSettings: (updates: Partial<GlobalSettings>) => void
}

export function BrowserPasswordManagerDialog({
  open,
  onOpenChange,
  profiles,
  settings,
  updateSettings
}: BrowserPasswordManagerDialogProps): React.JSX.Element {
  const [profileId, setProfileId] = useState('default')
  const browserProfileId = profiles.some((profile) => profile.id === profileId)
    ? profileId
    : 'default'
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent surface="security" scrollable className="sm:max-w-2xl">
        <DialogHeader>
          <DialogTitle>
            {translate('settings.browser.passwords.manageTitle', 'Manage passwords')}
          </DialogTitle>
        </DialogHeader>
        {open ? (
          <BrowserPasswordManagerProfile
            key={browserProfileId}
            browserProfileId={browserProfileId}
            profiles={profiles}
            settings={settings}
            updateSettings={updateSettings}
            onProfileChange={setProfileId}
          />
        ) : null}
      </DialogContent>
    </Dialog>
  )
}

function BrowserPasswordManagerProfile({
  browserProfileId,
  profiles,
  settings,
  updateSettings,
  onProfileChange
}: Omit<BrowserPasswordManagerDialogProps, 'open' | 'onOpenChange'> & {
  browserProfileId: string
  onProfileChange: (id: string) => void
}): React.JSX.Element {
  const api = window.api.browserPasswords
  const confirm = useConfirmationDialog()
  const [view, setView] = useState<VaultView>(EMPTY_VIEW)
  const [form, setForm] = useState<BrowserPasswordEntryFormStart | null>(null)

  const refresh = useCallback(async () => {
    const [status, entries, neverOrigins] = await Promise.all([
      api.getStatus({ browserProfileId }),
      api.list({ browserProfileId }),
      api.listNever({ browserProfileId })
    ])
    setView({ status, entries: entries ?? [], neverOrigins: neverOrigins ?? [] })
  }, [api, browserProfileId])

  useEffect(() => {
    void refresh()
  }, [refresh])

  const runImport = async (run: () => Promise<BrowserPasswordImportResult>): Promise<void> => {
    toastBrowserPasswordImportResult(await run())
    await refresh()
  }
  const importCsv = (): void => void runImport(() => api.importCsv({ browserProfileId }))
  const importBrowser = (source: BrowserPasswordImportSource): void =>
    void runImport(() => api.importFromBrowser({ browserProfileId, ...source }))

  const deleteAll = async (): Promise<void> => {
    const confirmed = await confirm({
      title: translate(
        'settings.browser.passwords.deleteAllConfirmTitle',
        'Delete all password data?'
      ),
      description: translate(
        'settings.browser.passwords.deleteAllConfirmDescription',
        'Every saved password in this browser profile is permanently deleted. This can’t be undone.'
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

  return (
    <>
      {unavailableReason ? (
        <p className="text-sm text-muted-foreground">
          {translate(
            'settings.browser.passwords.unavailable',
            'Saved passwords are off on this computer: {{reason}}',
            { reason: unavailableReason }
          )}
        </p>
      ) : form ? (
        <BrowserPasswordEntryForm
          key={form.mode === 'edit' ? form.entryId : 'add'}
          browserProfileId={browserProfileId}
          start={form}
          onDone={(saved) => {
            setForm(null)
            if (saved) {
              void refresh()
            }
          }}
        />
      ) : (
        <Tabs defaultValue="passwords">
          <div className="flex items-center justify-between gap-3">
            <TabsList>
              <TabsTrigger value="passwords">
                {translate('settings.browser.passwords.tabPasswords', 'Passwords')}
              </TabsTrigger>
              <TabsTrigger value="advanced">
                {translate('settings.browser.passwords.tabAdvanced', 'Advanced')}
              </TabsTrigger>
            </TabsList>
            {profiles.length > 1 ? (
              <Select value={browserProfileId} onValueChange={onProfileChange}>
                <SelectTrigger size="sm" className="w-48">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  {profiles.map((profile) => (
                    <SelectItem key={profile.id} value={profile.id}>
                      {profile.label}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            ) : null}
          </div>
          <TabsContent value="passwords">
            <BrowserPasswordListTab
              browserProfileId={browserProfileId}
              entries={view.entries}
              neverOrigins={view.neverOrigins}
              onChanged={() => void refresh()}
              onOpenForm={setForm}
              onImportCsv={importCsv}
            />
          </TabsContent>
          <TabsContent value="advanced">
            <BrowserPasswordAdvancedTab
              settings={settings}
              updateSettings={updateSettings}
              status={view.status}
              onImportCsv={importCsv}
              onImportBrowser={importBrowser}
              onDeleteAll={() => void deleteAll()}
            />
          </TabsContent>
        </Tabs>
      )}
    </>
  )
}
