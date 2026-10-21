import { useCallback, useEffect, useMemo, useState } from 'react'
import { toast } from 'sonner'
import type { SshTarget } from '../../../../shared/ssh-types'
import { useAppStore } from '@/store'
import { toastSshConnectFailure } from '@/ssh/ssh-connect-failure-toast'
import { useMountedRef } from '@/hooks/useMountedRef'
import { SshTargetList } from './SshTargetList'
import { SshTargetsEmptyState } from './SshTargetsEmptyState'
import { SshTargetDestructiveActions } from './SshTargetDestructiveActions'
import { SshHostsHeaderActions, SshHostsListToolbar } from './SshPaneToolbar'
import { SshHostsHeaderPortal } from './ssh-hosts-header-slot'
import { useSshTargetTests } from './use-ssh-target-tests'
import { SshRestoreRemovedHostsDialog } from './SshRestoreRemovedHostsDialog'
import { useSshConfigSync } from './use-ssh-config-sync'
import { useSshTargetSelection } from './use-ssh-target-selection'
import {
  countSshTargetsBySource,
  filterSshTargets,
  SSH_TARGET_FILTER_THRESHOLD,
  sshTargetDisplayOrder
} from './ssh-target-list-model'
import { useSshBulkRemove } from './use-ssh-bulk-remove'
import { SshTargetForm, EMPTY_FORM, type EditingTarget } from './SshTargetForm'
import { getEditingTargetForSshTarget } from './ssh-target-draft'
import { buildSshTargetSavePayload } from './ssh-target-save-payload'
import { HostRemoveDialog } from '../sidebar/HostRemoveDialog'
import { isManagedServerSshHost, SshManagedHostRemoveDialog } from './SshManagedHostRemoveDialog'
import { extractIpcErrorMessage } from '@/lib/ipc-error'
import { resolveSshHostRemoval } from '../sidebar/ssh-host-remove-resolution'
import { getAllWorktreesFromState } from '@/store/selectors'
import { toSshExecutionHostId } from '../../../../shared/execution-host'
import { translate } from '@/i18n/i18n'
import { useSshAddTargetIntent } from './use-ssh-add-target-intent'
import { syncSshConfigTargetsPassively } from '../../lib/ssh-config-passive-sync'
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
  const { testingIds, testOne, testMany, bulkTesting } = useSshTargetTests()
  // Why: when a target still has workspaces, route removal through the shared
  // workspace-aware HostRemoveDialog (same as the sidebar) instead of the plain
  // confirm, so the user chooses to delete or keep them rather than silently
  // orphaning them.
  const [hostRemoveTarget, setHostRemoveTarget] = useState<{
    targetId: string
    label: string
  } | null>(null)
  const [managedHostRemoveLabel, setManagedHostRemoveLabel] = useState<string | null>(null)
  const mountedRef = useMountedRef()
  const [filter, setFilter] = useState('')
  const [restoreOpen, setRestoreOpen] = useState(false)
  const visibleTargets = useMemo(() => filterSshTargets(targets, filter), [targets, filter])
  const visibleIds = useMemo(() => sshTargetDisplayOrder(visibleTargets), [visibleTargets])
  const selection = useSshTargetSelection(visibleIds)
  // Hosts a filter change deselected; said once in the bulk slot so the bar doesn't just vanish.
  const [hiddenDeselected, setHiddenDeselected] = useState(0)
  if (hiddenDeselected > 0 && selection.selected.size > 0) {
    setHiddenDeselected(0)
  }
  const changeFilter = (value: string): void => {
    setFilter(value)
    // Why: a host the filter hides must not stay selected and be removed unseen.
    const nextVisible = new Set(filterSshTargets(targets, value).map((target) => target.id))
    const dropped = [...selection.selected].filter((id) => !nextVisible.has(id)).length
    selection.retain([...nextVisible])
    setHiddenDeselected((prev) => (value.trim() === '' ? 0 : prev + dropped))
  }
  const totalBySource = useMemo(() => countSshTargetsBySource(targets), [targets])

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
      await syncSshConfigTargetsPassively()
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
  const { syncing, sync } = useSshConfigSync(loadTargets)

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
          err instanceof Error
            ? err.message
            : translate('auto.components.settings.SshPane.2227ce47b6', 'Failed to save target')
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
    const stored = targets.find((candidate) => candidate.id === target.id)
    if (stored && isManagedServerSshHost(stored)) {
      setManagedHostRemoveLabel(target.label)
      return
    }
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

  const removeTargetQuietly = async (id: string): Promise<void> => {
    await window.api.ssh.removeTarget({ id })
    // Why: a deleted passphrase-gated target may still have deferred
    // reconnect metadata; clear it so focused SSH tabs stop retrying it.
    clearRemovedSshTargetState(id)
  }

  const handleRemove = async (id: string): Promise<void> => {
    try {
      await removeTargetQuietly(id)
      if (mountedRef.current) {
        toast.success(translate('auto.components.settings.SshPane.a0237eb1ca', 'Target removed'))
      }
      await loadTargets()
    } catch (err) {
      if (mountedRef.current) {
        toast.error(
          extractIpcErrorMessage(
            err,
            translate('auto.components.settings.SshPane.c2a69510e3', 'Failed to remove target')
          )
        )
      }
    }
  }

  const { requestRemoveSelected, finishBulkRemove } = useSshBulkRemove({
    targets,
    selected: selection.selected,
    clearSelection: selection.clear,
    reload: loadTargets,
    requestSingleRemove: requestRemoveTarget
  })

  const handleEdit = (target: SshTarget): void => {
    setEditingId(target.id)
    setForm(getEditingTargetForSshTarget(target))
    setShowForm(true)
  }

  const handleConnect = async (targetId: string): Promise<void> => {
    try {
      await window.api.ssh.connect({ targetId })
      recordFeatureInteraction('ssh')
    } catch (err) {
      toastSshConnectFailure(
        targetId,
        err,
        translate('auto.components.settings.SshPane.e95d5ae10e', 'Connection failed')
      )
    }
  }

  const handleDisconnect = async (targetId: string): Promise<void> => {
    try {
      await window.api.ssh.disconnect({ targetId })
      recordFeatureInteraction('ssh')
    } catch (err) {
      toast.error(
        err instanceof Error
          ? err.message
          : translate('auto.components.settings.SshPane.a43de1d3ee', 'Disconnect failed')
      )
    }
  }

  const cancelForm = (): void => {
    setShowForm(false)
    setEditingId(null)
    setForm(EMPTY_FORM)
  }

  return (
    <div className="space-y-3">
      <SshHostsHeaderPortal>
        <SshHostsHeaderActions
          syncing={syncing}
          onSync={() => void sync()}
          onAdd={openAddTargetForm}
          onRestoreRemoved={() => setRestoreOpen(true)}
        />
      </SshHostsHeaderPortal>
      <SshTargetDestructiveActions
        onRemove={handleRemove}
        removeQuietly={removeTargetQuietly}
        onBulkRemoveFinished={finishBulkRemove}
      >
        {({ busyActionForTarget, requestRemove, requestBulkRemove }) => (
          <>
            <SshHostsListToolbar
              totalCount={targets.length}
              visibleCount={visibleTargets.length}
              selectedCount={selection.selected.size}
              allVisibleSelected={visibleIds.every((id) => selection.selected.has(id))}
              // Why: a reload can drop the list under the threshold; an active filter must stay clearable.
              showFilter={targets.length > SSH_TARGET_FILTER_THRESHOLD || filter !== ''}
              filter={filter}
              busy={[...selection.selected].some((id) => busyActionForTarget(id) === 'remove')}
              testing={bulkTesting}
              hiddenDeselectedCount={hiddenDeselected}
              onFilterChange={changeFilter}
              onSelectVisible={() => selection.setGroup(visibleIds, true)}
              onClearSelection={selection.clear}
              onTestSelected={() =>
                void testMany(targets.filter((target) => selection.selected.has(target.id)))
              }
              onRemoveSelected={() => requestRemoveSelected(requestBulkRemove, requestRemove)}
            />
            {targets.length === 0 ? (
              <SshTargetsEmptyState />
            ) : visibleTargets.length === 0 ? (
              <p className="px-1 py-4 text-center text-xs text-muted-foreground">
                {translate('auto.components.settings.SshPane.noFilterMatch', 'No hosts match.')}
              </p>
            ) : (
              <SshTargetList
                targets={visibleTargets}
                totalBySource={totalBySource}
                connectionStates={sshConnectionStates}
                testingIds={testingIds}
                busyActionForTarget={busyActionForTarget}
                selection={selection}
                onConnect={handleConnect}
                onDisconnect={handleDisconnect}
                onTest={testOne}
                onEdit={handleEdit}
                onRemove={(target) => requestRemoveTarget(target, requestRemove)}
                onServerChanged={() => void loadTargets()}
              />
            )}
          </>
        )}
      </SshTargetDestructiveActions>

      <SshRestoreRemovedHostsDialog
        open={restoreOpen}
        busy={syncing}
        onOpenChange={setRestoreOpen}
        onConfirm={async () => {
          await sync({ restoreRemoved: true })
          if (mountedRef.current) {
            setRestoreOpen(false)
          }
        }}
      />

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

      <SshManagedHostRemoveDialog
        label={managedHostRemoveLabel}
        onClose={() => setManagedHostRemoveLabel(null)}
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
