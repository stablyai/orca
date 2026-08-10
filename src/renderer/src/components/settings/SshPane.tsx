import { useCallback, useEffect, useState } from 'react'
import { toast } from 'sonner'
import { Plus, Upload } from 'lucide-react'
import type { SshTarget } from '../../../../shared/ssh-types'
import { useAppStore } from '@/store'
import { useMountedRef } from '@/hooks/useMountedRef'
import { Button } from '../ui/button'
import { SshTargetCard } from './SshTargetCard'
import { SshTargetDestructiveActions } from './SshTargetDestructiveActions'
import { SshTargetForm, EMPTY_FORM, type EditingTarget } from './SshTargetForm'
import { getEditingTargetForSshTarget } from './ssh-target-draft'
import { buildSshTargetSavePayload } from './ssh-target-save-payload'
import { formatSshErrorOrFallback } from './ssh-user-facing-error'
import {
  connectSshPaneTarget,
  disconnectSshPaneTarget,
  importSshPaneConfig,
  removeSshPaneTarget,
  resetSshPaneRelay,
  terminateSshPaneSessions,
  testSshPaneConnection
} from './ssh-pane-host-actions'
import { HostRemoveDialog } from '../sidebar/HostRemoveDialog'
import { resolveSshHostRemoval } from '../sidebar/ssh-host-remove-resolution'
import { getAllWorktreesFromState } from '@/store/selectors'
import { toSshExecutionHostId } from '../../../../shared/execution-host'
import { translate } from '@/i18n/i18n'
import { useSshAddTargetIntent } from './use-ssh-add-target-intent'
export { getSshPaneSearchEntries } from './ssh-search'

type SshPaneProps = { addTargetIntentSignal?: number }

export function SshPane({ addTargetIntentSignal }: SshPaneProps): React.JSX.Element {
  const [targets, setTargets] = useState<SshTarget[]>([])
  // Why: connection states are already hydrated and kept up-to-date by the
  // global store (via useIpcEvents.ts). Reading from the store avoids
  // duplicating the onStateChanged listener and per-target getState IPC calls.
  const sshConnectionStates = useAppStore((s) => s.sshConnectionStates)
  const recordFeatureInteraction = useAppStore((s) => s.recordFeatureInteraction)
  const [showForm, setShowForm] = useState(false)
  const [editingId, setEditingId] = useState<string | null>(null)
  const [form, setForm] = useState<EditingTarget>(EMPTY_FORM)
  // Why: gates the submit button and the Enter path so a double click cannot
  // land two addTarget/updateTarget writes for one draft.
  const [saving, setSaving] = useState(false)
  const [testingIds, setTestingIds] = useState<Set<string>>(new Set())
  // Why: when a target still has workspaces, route removal through the shared
  // workspace-aware HostRemoveDialog (same as the sidebar) instead of the plain
  // confirm, so the user chooses to delete or keep them rather than silently
  // orphaning them.
  const [hostRemoveTarget, setHostRemoveTarget] = useState<{
    targetId: string
    label: string
  } | null>(null)
  const mountedRef = useMountedRef()

  const setSshTargetsMetadata = useAppStore((s) => s.setSshTargetsMetadata)
  const clearRemovedSshTargetState = useAppStore((s) => s.clearRemovedSshTargetState)

  const loadTargets = useCallback(
    async (opts?: { signal?: AbortSignal }) => {
      try {
        const result = (await window.api.ssh.listTargets()) as SshTarget[]
        if (opts?.signal?.aborted || !mountedRef.current) {
          return
        }
        setTargets(result)
        setSshTargetsMetadata(result)
      } catch {
        if (!opts?.signal?.aborted && mountedRef.current) {
          toast.error(
            translate('auto.components.settings.SshPane.f1fc50dad2', 'Failed to load SSH targets')
          )
        }
      }
    },
    [mountedRef, setSshTargetsMetadata]
  )

  useEffect(() => {
    const abortController = new AbortController()
    // Why: auto-sync ~/.ssh/config when the Manage pane opens so rotated ports
    // and newly added hosts appear without a manual Import click. Best-effort —
    // a sync failure must not block listing the already-known targets.
    void (async () => {
      try {
        const result = await window.api.ssh.importConfig()
        useAppStore.getState().recordSshRepoReadoptions(result.repoReadoptions)
      } catch {
        // Surfaced on demand via the explicit Import button; ignore here.
      }
      if (abortController.signal.aborted) {
        return
      }
      await loadTargets({ signal: abortController.signal })
    })()
    return () => abortController.abort()
  }, [loadTargets])

  const openAddTargetForm = useCallback((): void => {
    // Why: composer deep-links should land on the existing add form, not just
    // the host management pane.
    setEditingId(null)
    setForm(EMPTY_FORM)
    setShowForm(true)
  }, [])
  useSshAddTargetIntent(addTargetIntentSignal, openAddTargetForm)

  const handleSave = async (): Promise<void> => {
    const savePayload = buildSshTargetSavePayload(form)
    if (!savePayload.ok) {
      toast.error(savePayload.error)
      return
    }
    if (saving) {
      return
    }
    setSaving(true)

    try {
      if (editingId) {
        await window.api.ssh.updateTarget({ id: editingId, updates: savePayload.payload.updates })
      } else {
        const result = await window.api.ssh.addTarget({ target: savePayload.payload.target })
        useAppStore.getState().recordSshRepoReadoptions(result.repoReadoptions)
      }
      recordFeatureInteraction('ssh')
      if (!mountedRef.current) {
        return
      }
      toast.success(
        editingId
          ? translate('auto.components.settings.SshPane.b4ba0ce33d', 'Target updated')
          : translate('auto.components.settings.SshPane.f602009125', 'Target added')
      )
      setShowForm(false)
      setEditingId(null)
      setForm(EMPTY_FORM)
      await loadTargets()
    } catch (err) {
      if (mountedRef.current) {
        toast.error(
          formatSshErrorOrFallback(
            err,
            translate('auto.components.settings.SshPane.2227ce47b6', 'Failed to save target')
          )
        )
      }
    } finally {
      if (mountedRef.current) {
        setSaving(false)
      }
    }
  }

  // Route removal through the workspace-aware dialog when the target still owns
  // workspaces; otherwise use the plain confirm (which also ends remote PTYs).
  const requestRemoveTarget = (
    target: { id: string; label: string },
    requestPlainRemove: (target: { id: string; label: string }) => void
  ): void => {
    const resolution = resolveSshHostRemoval({
      targetId: target.id,
      repos: useAppStore.getState().repos,
      worktrees: getAllWorktreesFromState(useAppStore.getState()),
      sshConnectionStates: useAppStore.getState().sshConnectionStates
    })
    if (resolution.workspaceCount > 0) {
      setHostRemoveTarget({ targetId: target.id, label: target.label })
      return
    }
    requestPlainRemove(target)
  }

  const handleRemove = async (id: string): Promise<void> => {
    await removeSshPaneTarget({
      id,
      mountedRef,
      clearRemovedSshTargetState,
      loadTargets
    })
  }

  const handleEdit = (target: SshTarget): void => {
    setEditingId(target.id)
    setForm(getEditingTargetForSshTarget(target))
    setShowForm(true)
  }

  const handleConnect = async (targetId: string): Promise<void> => {
    await connectSshPaneTarget(targetId, recordFeatureInteraction)
  }

  const handleDisconnect = async (targetId: string): Promise<void> => {
    await disconnectSshPaneTarget(targetId, recordFeatureInteraction)
  }

  const handleTerminateSessions = async (targetId: string): Promise<void> => {
    await terminateSshPaneSessions(targetId)
  }

  const handleResetRelay = async (targetId: string): Promise<void> => {
    await resetSshPaneRelay({ targetId, mountedRef, loadTargets })
  }

  const handleTest = async (targetId: string): Promise<void> => {
    await testSshPaneConnection({
      targetId,
      mountedRef,
      recordFeatureInteraction,
      setTestingIds
    })
  }

  const handleImport = async (): Promise<void> => {
    await importSshPaneConfig({
      mountedRef,
      recordFeatureInteraction,
      loadTargets
    })
  }

  const cancelForm = (): void => {
    setShowForm(false)
    setEditingId(null)
    setForm(EMPTY_FORM)
  }

  return (
    <div className="space-y-4">
      {/* Header row */}
      <div className="flex items-center justify-between gap-3">
        <div className="space-y-0.5">
          <p className="text-sm font-medium">
            {translate('auto.components.settings.SshPane.94c5284560', 'SSH hosts')}
          </p>
          <p className="text-xs text-muted-foreground">
            {translate(
              'auto.components.settings.SshPane.a7d28dff81',
              'Add an existing machine over SSH so projects and workspaces can run there.'
            )}
          </p>
        </div>
        <div className="flex shrink-0 items-center gap-1.5">
          <Button
            variant="outline"
            size="xs"
            onClick={() => void handleImport()}
            className="gap-1.5"
          >
            <Upload className="size-3" />
            {translate('auto.components.settings.SshPane.51d7dba44d', 'Import')}
          </Button>
          <Button variant="outline" size="xs" onClick={openAddTargetForm} className="gap-1.5">
            <Plus className="size-3" />
            {translate('auto.components.settings.SshPane.639ceb3698', 'Add Target')}
          </Button>
        </div>
      </div>

      <SshTargetDestructiveActions
        connectionStates={sshConnectionStates}
        onRemove={handleRemove}
        onResetRelay={handleResetRelay}
        onTerminateSessions={handleTerminateSessions}
      >
        {({ busyActionForTarget, requestRemove, requestResetRelay, requestTerminateSessions }) => (
          <>
            {/* Target list */}
            {targets.length === 0 ? (
              <div className="flex items-center justify-center rounded-lg border border-dashed border-border/60 bg-card/30 px-4 py-5 text-sm text-muted-foreground">
                {translate(
                  'auto.components.settings.SshPane.c0f1c80166',
                  'No SSH targets configured.'
                )}
              </div>
            ) : (
              <div className="space-y-2">
                {targets.map((target) => (
                  <SshTargetCard
                    key={target.id}
                    target={target}
                    state={sshConnectionStates.get(target.id)}
                    testing={testingIds.has(target.id)}
                    busyAction={busyActionForTarget(target.id)}
                    onConnect={handleConnect}
                    onDisconnect={handleDisconnect}
                    onTerminateSessions={(id) =>
                      requestTerminateSessions({ id, label: target.label })
                    }
                    onResetRelay={(id) => requestResetRelay({ id, label: target.label })}
                    onTest={handleTest}
                    onEdit={handleEdit}
                    onRemove={(id) =>
                      requestRemoveTarget({ id, label: target.label }, requestRemove)
                    }
                  />
                ))}
              </div>
            )}
          </>
        )}
      </SshTargetDestructiveActions>

      {/* Why: modal keeps the form in viewport over long host lists (STA-3067). */}
      <SshTargetForm
        open={showForm}
        editingId={editingId}
        form={form}
        saving={saving}
        onFormChange={setForm}
        onSave={() => void handleSave()}
        onOpenChange={(nextOpen) => {
          if (!nextOpen) {
            cancelForm()
          }
        }}
      />

      {hostRemoveTarget ? (
        <HostRemoveDialog
          open
          onOpenChange={(open) => {
            if (!open) {
              setHostRemoveTarget(null)
              void loadTargets()
            }
          }}
          hostId={toSshExecutionHostId(hostRemoveTarget.targetId)}
          label={hostRemoveTarget.label}
          target={{ kind: 'ssh', targetId: hostRemoveTarget.targetId }}
        />
      ) : null}
    </div>
  )
}
