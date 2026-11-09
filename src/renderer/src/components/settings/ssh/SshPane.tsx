import { selectWorktreesByRepo } from '@/store/workspaces/catalog/workspace-record-fields'
import { useCallback, useEffect, useMemo, useState } from 'react'
import { toast } from 'sonner'
import type { SshTarget } from '../../../../../shared/ssh-types'
import { useAppStore } from '@/store/index'
import { toastSshConnectFailure } from '@/ssh/ssh-connect-failure-toast'
import { useMountedRef } from '@/hooks/useMountedRef'
import { SshTargetList } from './targets/SshTargetList'
import { SshTargetsEmptyState } from './targets/SshTargetsEmptyState'
import { SshTargetDestructiveActions } from './targets/SshTargetDestructiveActions'
import { SshHostsHeaderActions, SshHostsListToolbar } from './SshPaneToolbar'
import { SshHostsHeaderPortal } from './ssh-hosts-header-slot'
import { useSshTargetTests } from './targets/use-ssh-target-tests'
import { SshRestoreRemovedHostsDialog } from './targets/SshRestoreRemovedHostsDialog'
import { useSshConfigSync } from './targets/use-ssh-config-sync'
import { useSshTargetSelection } from './targets/use-ssh-target-selection'
import {
  countSshTargetsBySource,
  filterSshTargets,
  SSH_TARGET_FILTER_THRESHOLD,
  sshTargetDisplayOrder
} from './targets/ssh-target-list-model'
import { useSshBulkRemove } from './targets/use-ssh-bulk-remove'
import { SshTargetForm } from './targets/SshTargetForm'
import {
  EMPTY_FORM,
  type EditingTarget,
  getEditingTargetForSshTarget
} from '../../ssh-host-form/ssh-target-draft'

import { buildSshTargetSavePayload } from './targets/ssh-target-save-payload'
import { HostRemoveDialog } from '../../sidebar/HostRemoveDialog'
import {
  isManagedServerSshHost,
  SshManagedHostRemoveDialog
} from './targets/SshManagedHostRemoveDialog'
import { extractIpcErrorMessage } from '@/lib/ipc-error'
import { resolveSshHostRemoval } from '../../sidebar/ssh-host-remove-resolution'
import { getIndexedAllWorktrees } from '@/store/slices/worktrees/listing/worktree-catalog-index'
import { toSshExecutionHostId } from '../../../../../shared/execution-host'
import { translate } from '@/i18n/i18n'
import { useTranslate } from '@/i18n/use-translate'
import { useSshAddTargetIntent } from './targets/use-ssh-add-target-intent'
import { syncSshConfigTargetsPassively } from '../../../lib/ssh-config-passive-sync'

type SshPaneProps = { addTargetIntentSignal?: number }

export function SshPane({ addTargetIntentSignal }: SshPaneProps): React.JSX.Element {
  const t = useTranslate()
  const [targets, setTargets] = useState<SshTarget[]>([])
  // Reuse globally hydrated SSH state instead of duplicate listeners and per-target IPC reads.
  const sshConnectionStates = useAppStore((s) => s.sshConnectionStates)
  const recordFeatureInteraction = useAppStore((s) => s.recordFeatureInteraction)
  const [showForm, setShowForm] = useState(false)
  const [editingId, setEditingId] = useState<string | null>(null)
  const [form, setForm] = useState<EditingTarget>(EMPTY_FORM)
  // Guard both clicks and Enter so one draft cannot create duplicate writes.
  const [saving, setSaving] = useState(false)
  const { testingIds, testOne, testMany, bulkTesting } = useSshTargetTests()
  // Use the shared workspace-aware removal dialog so users choose whether to delete or keep owned workspaces.
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
    // Best-effort sync ssh/config on opening to pick up new hosts/ports without blocking known-host listing.
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
    // Composer deep-links open the existing add form.
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
          ? t('auto.components.settings.SshPane.b4ba0ce33d', 'Target updated')
          : t('auto.components.settings.SshPane.f602009125', 'Target added')
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
            : t('auto.components.settings.SshPane.2227ce47b6', 'Failed to save target')
        )
      }
    } finally {
      if (mountedRef.current) {
        setSaving(false)
      }
    }
  }

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
      worktrees: getIndexedAllWorktrees(selectWorktreesByRepo(useAppStore.getState()))
    })
    if (resolution.workspaceCount > 0) {
      setHostRemoveTarget({ targetId: target.id, label: target.label })
      return
    }
    requestPlainRemove(target)
  }

  const removeTargetQuietly = async (id: string): Promise<void> => {
    await window.api.ssh.removeTarget({ id })
  }

  const handleRemove = async (id: string): Promise<void> => {
    try {
      await removeTargetQuietly(id)
      if (mountedRef.current) {
        toast.success(t('auto.components.settings.SshPane.a0237eb1ca', 'Target removed'))
      }
      await loadTargets()
    } catch (err) {
      if (mountedRef.current) {
        toast.error(
          extractIpcErrorMessage(
            err,
            t('auto.components.settings.SshPane.c2a69510e3', 'Failed to remove target')
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
        t('auto.components.settings.SshPane.e95d5ae10e', 'Connection failed')
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
          : t('auto.components.settings.SshPane.a43de1d3ee', 'Disconnect failed')
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
              // Keep active filters clearable even when reload drops the list below the threshold.
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
                {t('auto.components.settings.SshPane.noFilterMatch', 'No hosts match.')}
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

      {/* Use a modal to keep long-list forms in the viewport (STA-3067). */}
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
