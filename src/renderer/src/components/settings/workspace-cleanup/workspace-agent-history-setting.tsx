import { useEffect, useState } from 'react'
import { LoaderCircle } from 'lucide-react'
import { toast } from 'sonner'
import { useTranslate } from '@/i18n/use-translate'
import { uiNumberFormat } from '@/i18n/ui-intl-formatters'
import { useMountedRef } from '@/hooks/useMountedRef'
import type { GlobalSettings } from '../../../../../shared/global-settings-types'
import type {
  WorkspaceAgentHistoryMeasurement,
  WorkspaceAgentHistoryTally
} from '../../../../../shared/workspace-agent-history/workspace-agent-history-types'
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

// Revisiting Settings reuses a recent measurement instead of rescanning every transcript.
const MEASUREMENT_REUSE_MS = 60_000
let lastMeasurement: { tally: WorkspaceAgentHistoryMeasurement; at: number } | null = null

function freshMeasurement(): WorkspaceAgentHistoryMeasurement | null {
  return lastMeasurement && Date.now() - lastMeasurement.at < MEASUREMENT_REUSE_MS
    ? lastMeasurement.tally
    : null
}

function formatCount(value: number): string {
  return uiNumberFormat({}).format(value)
}

function requestHistoryDelete(
  planId: string
): Promise<{ ok: true; result: WorkspaceAgentHistoryTally } | { ok: false; message: string }> {
  return window.api.aiVault.deleteDeletedWorkspaceHistory(planId).then(
    (result) => ({ ok: true as const, result }),
    (error: unknown) => ({ ok: false as const, message: errorMessage(error) })
  )
}

type Measurement =
  | { state: 'measuring' }
  | { state: 'ready'; tally: WorkspaceAgentHistoryMeasurement }
  | { state: 'error'; message: string }

function DeletedWorkspacesHistoryRow(): React.JSX.Element {
  const t = useTranslate()
  const mountedRef = useMountedRef()
  const [measurement, setMeasurement] = useState<Measurement>(() => {
    const cached = freshMeasurement()
    return cached ? { state: 'ready', tally: cached } : { state: 'measuring' }
  })
  // The dialog keeps the counts it opened with, even while the row re-measures behind it.
  const [confirming, setConfirming] = useState(false)
  const [confirmTally, setConfirmTally] = useState<WorkspaceAgentHistoryMeasurement | null>(null)
  const [deleting, setDeleting] = useState(false)

  const [generation, setGeneration] = useState(0)

  // Measured when the row first appears and after a delete, never per render: it scans every transcript.
  useEffect(() => {
    if (generation === 0 && freshMeasurement()) {
      return
    }
    let current = true
    window.api.aiVault.measureDeletedWorkspaceHistory().then(
      (tally) => {
        lastMeasurement = { tally, at: Date.now() }
        if (current) {
          setMeasurement({ state: 'ready', tally })
        }
      },
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

  const confirmDelete = async (planId: string): Promise<void> => {
    setDeleting(true)
    lastMeasurement = null
    const outcome = await requestHistoryDelete(planId)
    if (outcome.ok) {
      const { result } = outcome
      const skipped = result.transcripts.inUse + result.transcripts.failed + result.chats.inUse
      toast.success(
        t(
          'components.settings.workspaceCleanup.agentHistory.deleted',
          'Agent sessions deleted: {{sessions}}. Orca chats deleted: {{chats}}.',
          { sessions: result.transcripts.deleted, chats: result.chats.deleted }
        ),
        skipped > 0
          ? {
              description: t(
                'components.settings.workspaceCleanup.agentHistory.skipped',
                'Kept because in use or not removable: {{count}}.',
                { count: skipped }
              )
            }
          : undefined
      )
    } else {
      toast.error(
        t(
          'components.settings.workspaceCleanup.agentHistory.deleteFailed',
          "Couldn't delete history from deleted workspaces."
        ),
        { description: outcome.message }
      )
    }
    if (mountedRef.current) {
      setDeleting(false)
      setConfirming(false)
      setMeasurement({ state: 'measuring' })
      setGeneration((value) => value + 1)
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
              sessions: formatCount(measurement.tally.transcripts.matched),
              sessionTotal: formatCount(measurement.tally.transcripts.total),
              size: formatBytes(measurement.tally.transcripts.bytes),
              chats: formatCount(measurement.tally.chats.matched),
              chatTotal: formatCount(measurement.tally.chats.total)
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
          measurement.state === 'error' ? (
            <Button
              variant="outline"
              size="sm"
              onClick={() => {
                setMeasurement({ state: 'measuring' })
                setGeneration((value) => value + 1)
              }}
            >
              {t('components.settings.workspaceCleanup.agentHistory.retry', 'Try again')}
            </Button>
          ) : (
            <Button
              variant="outline"
              size="sm"
              disabled={deletable === 0 || deleting}
              onClick={() => {
                setConfirmTally(tally)
                setConfirming(true)
              }}
            >
              {t('components.settings.workspaceCleanup.agentHistory.delete', 'Delete…')}
            </Button>
          )
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
            <DialogTitle>
              {t(
                'components.settings.workspaceCleanup.agentHistory.confirmTitle',
                'Delete history from deleted workspaces?'
              )}
            </DialogTitle>
            <DialogDescription>
              {t(
                'components.settings.workspaceCleanup.agentHistory.confirmBody',
                "Deletes from this computer: agent sessions, {{sessions}} ({{size}}); Orca chats, {{chats}}. Anything in use is skipped. This can't be undone.",
                {
                  sessions: confirmTally
                    ? formatCount(confirmTally.transcripts.matched - confirmTally.transcripts.inUse)
                    : '0',
                  size: formatBytes(confirmTally?.transcripts.bytes ?? 0),
                  chats: confirmTally
                    ? formatCount(confirmTally.chats.matched - confirmTally.chats.inUse)
                    : '0'
                }
              )}
            </DialogDescription>
          </DialogHeader>
          <DialogFooter>
            <Button variant="outline" onClick={() => setConfirming(false)} disabled={deleting}>
              {t('components.settings.workspaceCleanup.agentHistory.cancel', 'Cancel')}
            </Button>
            <Button
              variant="destructive"
              onClick={() => confirmTally && void confirmDelete(confirmTally.planId)}
              disabled={deleting || !confirmTally}
            >
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
