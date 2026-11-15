import { useEffect, useState } from 'react'
import { LoaderCircle } from 'lucide-react'
import { toast } from 'sonner'
import { useTranslate } from '@/i18n/use-translate'
import { useMountedRef } from '@/hooks/useMountedRef'
import type { GlobalSettings } from '../../../../../shared/global-settings-types'
import type { WorkspaceAgentHistoryTally } from '../../../../../shared/workspace-agent-history/workspace-agent-history-types'
import { errorMessage } from '../../../../../shared/errors/error-message'
import { formatBytes } from '../../../../../shared/format-bytes'
import { Button } from '../../ui/button'
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle
} from '../../ui/dialog'
import { SettingsRow, SettingsSwitchRow } from '../form-controls/SettingsFormControls'
import { SettingsGroup, SettingsGroupNestedRows } from '../section-layout/SettingsGroup'
import { SearchableSetting } from '../section-layout/SearchableSetting'
import { getWorkspaceCleanupSettingsSearchParts } from './workspace-cleanup-settings-search'
import { matchesSettingsSearch } from '../search/settings-search'
import type { SettingsHostScope } from '../host-scope/settings-host-scope'
import { useAppStateValue } from '@/store/retained-views/app-state-view'

export function WorkspaceAgentHistorySetting({
  hostScope,
  settings,
  updateSettings
}: {
  hostScope: SettingsHostScope
  settings: GlobalSettings | null
  updateSettings: (updates: Partial<GlobalSettings>) => Promise<void> | void
}): React.JSX.Element | null {
  const t = useTranslate()
  const query = useAppStateValue((state) => state.settingsSearchQuery)
  const search = getWorkspaceCleanupSettingsSearchParts().agentHistory
  // Transcripts are read from this computer's disk, so a remote server's scope has no such setting.
  if (
    hostScope.target.kind === 'environment' ||
    !settings ||
    !matchesSettingsSearch(query, [search])
  ) {
    return null
  }
  const enabled = settings.deleteAgentHistoryWithWorkspace === true
  return (
    <SettingsGroup title={t('components.settings.workspaceCleanup.agentHistory.group', 'History')}>
      <SearchableSetting {...search}>
        <SettingsSwitchRow
          label={search.title}
          description={search.description}
          checked={enabled}
          onChange={() => void updateSettings({ deleteAgentHistoryWithWorkspace: !enabled })}
        />
        {/* Turning the setting on never deletes old history; only this row's button does. */}
        {enabled ? (
          <SettingsGroupNestedRows>
            <DeletedWorkspacesHistoryRow />
          </SettingsGroupNestedRows>
        ) : null}
      </SearchableSetting>
    </SettingsGroup>
  )
}

type Measurement =
  | { state: 'measuring' }
  | { state: 'ready'; tally: WorkspaceAgentHistoryTally }
  | { state: 'error'; message: string }

function DeletedWorkspacesHistoryRow(): React.JSX.Element {
  const t = useTranslate()
  const mountedRef = useMountedRef()
  const [measurement, setMeasurement] = useState<Measurement>({ state: 'measuring' })
  const [confirming, setConfirming] = useState(false)
  const [deleting, setDeleting] = useState(false)

  const [generation, setGeneration] = useState(0)

  // Measured when the row appears and after a delete, never per render: it scans every transcript.
  useEffect(() => {
    let current = true
    window.api.aiVault.measureDeletedWorkspaceHistory().then(
      (tally) => current && setMeasurement({ state: 'ready', tally }),
      (error: unknown) =>
        current && setMeasurement({ state: 'error', message: errorMessage(error) })
    )
    return () => {
      current = false
    }
  }, [generation])

  const tally = measurement.state === 'ready' ? measurement.tally : null
  const deletable = tally
    ? tally.transcripts.matched - tally.transcripts.inUse + tally.chats.matched - tally.chats.inUse
    : 0

  const confirmDelete = async (): Promise<void> => {
    setDeleting(true)
    try {
      const result = await window.api.aiVault.deleteDeletedWorkspaceHistory()
      const skipped = result.transcripts.inUse + result.transcripts.failed + result.chats.inUse
      toast.success(
        t(
          'components.settings.workspaceCleanup.agentHistory.deleted',
          'Deleted {{sessions}} agent sessions and {{chats}} Orca chats.',
          { sessions: result.transcripts.deleted, chats: result.chats.deleted }
        ),
        skipped > 0
          ? {
              description: t(
                'components.settings.workspaceCleanup.agentHistory.skipped',
                'Kept {{count}} that were in use or could not be removed.',
                { count: skipped }
              )
            }
          : undefined
      )
    } catch (error) {
      toast.error(
        t(
          'components.settings.workspaceCleanup.agentHistory.deleteFailed',
          "Couldn't delete history from deleted workspaces."
        ),
        { description: errorMessage(error) }
      )
    } finally {
      if (mountedRef.current) {
        setDeleting(false)
        setConfirming(false)
        setMeasurement({ state: 'measuring' })
        setGeneration((value) => value + 1)
      }
    }
  }

  const summary =
    measurement.state === 'measuring'
      ? t('components.settings.workspaceCleanup.agentHistory.measuring', 'Measuring…')
      : measurement.state === 'error'
        ? t(
            'components.settings.workspaceCleanup.agentHistory.measureFailed',
            "Couldn't measure: {{error}}",
            { error: measurement.message }
          )
        : t(
            'components.settings.workspaceCleanup.agentHistory.summary',
            'History from deleted workspaces: {{sessions}} of {{sessionTotal}} agent sessions ({{size}}) and {{chats}} of {{chatTotal}} Orca chats.',
            {
              sessions: measurement.tally.transcripts.matched.toLocaleString(),
              sessionTotal: measurement.tally.transcripts.total.toLocaleString(),
              size: formatBytes(measurement.tally.transcripts.bytes),
              chats: measurement.tally.chats.matched.toLocaleString(),
              chatTotal: measurement.tally.chats.total.toLocaleString()
            }
          )
  const remoteNote = t(
    'components.settings.workspaceCleanup.agentHistory.remoteNote',
    'Only this computer is checked; workspaces on SSH hosts and servers keep their history.'
  )

  return (
    <>
      <SettingsRow
        label={t(
          'components.settings.workspaceCleanup.agentHistory.alreadyDeleted',
          'Workspaces already deleted'
        )}
        description={`${summary} ${remoteNote}`}
        control={
          <Button
            variant="outline"
            size="sm"
            disabled={deletable === 0 || deleting}
            onClick={() => setConfirming(true)}
          >
            {t('components.settings.workspaceCleanup.agentHistory.delete', 'Delete…')}
          </Button>
        }
      />
      <Dialog
        open={confirming}
        onOpenChange={(open) => {
          if (!open && !deleting) {
            setConfirming(false)
          }
        }}
      >
        <DialogContent className="max-w-md" showCloseButton={!deleting}>
          <DialogHeader>
            <DialogTitle className="text-sm">
              {t(
                'components.settings.workspaceCleanup.agentHistory.confirmTitle',
                'Delete history from deleted workspaces?'
              )}
            </DialogTitle>
            <DialogDescription className="text-xs">
              {t(
                'components.settings.workspaceCleanup.agentHistory.confirmBody',
                "Deletes {{sessions}} agent sessions ({{size}}) and {{chats}} Orca chats from this computer. Anything in use is skipped. This can't be undone.",
                {
                  sessions: tally
                    ? (tally.transcripts.matched - tally.transcripts.inUse).toLocaleString()
                    : '0',
                  size: formatBytes(tally?.transcripts.bytes ?? 0),
                  chats: tally ? (tally.chats.matched - tally.chats.inUse).toLocaleString() : '0'
                }
              )}
            </DialogDescription>
          </DialogHeader>
          <DialogFooter>
            <Button variant="outline" onClick={() => setConfirming(false)} disabled={deleting}>
              {t('components.settings.workspaceCleanup.agentHistory.cancel', 'Cancel')}
            </Button>
            <Button variant="destructive" onClick={() => void confirmDelete()} disabled={deleting}>
              {deleting ? <LoaderCircle className="size-4 animate-spin" /> : null}
              {deleting
                ? t('components.settings.workspaceCleanup.agentHistory.deleting', 'Deleting…')
                : t('components.settings.workspaceCleanup.agentHistory.confirm', 'Delete')}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </>
  )
}
