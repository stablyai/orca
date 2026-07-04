import { useCallback, useEffect, useState } from 'react'
import { toast } from 'sonner'
import { Plus, Upload } from 'lucide-react'
import type { SshTarget } from '../../../../shared/ssh-types'
import { SSH_TERMINATE_RECONNECT_REQUIRED } from '../../../../shared/constants'
import { useAppStore } from '@/store'
import { useMountedRef } from '@/hooks/useMountedRef'
import { Button } from '../ui/button'
import { removeSshTargetWithBestEffortCleanup } from './ssh-target-remove'
import { SshTargetCard } from './SshTargetCard'
import { SshTargetDestructiveActions } from './SshTargetDestructiveActions'
import { SshTargetForm, EMPTY_FORM, type EditingTarget } from './SshTargetForm'
import { getEditingTargetForSshTarget } from './ssh-target-draft'
import { buildSshTargetSavePayload } from './ssh-target-save-payload'
import { translate } from '@/i18n/i18n'
export { getSshPaneSearchEntries } from './ssh-search'

type SshPaneProps = Record<string, never>

export function SshPane(_props: SshPaneProps): React.JSX.Element {
  const [targets, setTargets] = useState<SshTarget[]>([])
  // Why: connection states are already hydrated and kept up-to-date by the
  // global store (via useIpcEvents.ts). Reading from the store avoids
  // duplicating the onStateChanged listener and per-target getState IPC calls.
  const sshConnectionStates = useAppStore((s) => s.sshConnectionStates)
  const recordFeatureInteraction = useAppStore((s) => s.recordFeatureInteraction)
  const [showForm, setShowForm] = useState(false)
  const [editingId, setEditingId] = useState<string | null>(null)
  const [form, setForm] = useState<EditingTarget>(EMPTY_FORM)
  const [testingIds, setTestingIds] = useState<Set<string>>(new Set())
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
        await window.api.ssh.importConfig()
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

  const handleSave = async (): Promise<void> => {
    const savePayload = buildSshTargetSavePayload(form)
    if (!savePayload.ok) {
      toast.error(savePayload.error)
      return
    }

    try {
      await (editingId
        ? window.api.ssh.updateTarget({ id: editingId, updates: savePayload.payload.updates })
        : window.api.ssh.addTarget({ target: savePayload.payload.target }))
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
    }
  }

  const terminateSessionsWithReconnect = async (targetId: string): Promise<void> => {
    try {
      await window.api.ssh.terminateSessions({ targetId })
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err)
      if (!message.includes(SSH_TERMINATE_RECONNECT_REQUIRED)) {
        throw err
      }
      // Why: disconnect is now non-destructive, so preserved remote PTYs may
      // require a fresh relay attachment before they can be explicitly killed.
      await window.api.ssh.connect({ targetId })
      await window.api.ssh.terminateSessions({ targetId })
    }
  }

  const handleRemove = async (id: string): Promise<void> => {
    try {
      await removeSshTargetWithBestEffortCleanup(window.api.ssh, id)
      // Why: a deleted passphrase-gated target may still have deferred
      // reconnect metadata; clear it so focused SSH tabs stop retrying it.
      clearRemovedSshTargetState(id)
      if (mountedRef.current) {
        toast.success(translate('auto.components.settings.SshPane.a0237eb1ca', 'Target removed'))
      }
      await loadTargets()
    } catch (err) {
      if (mountedRef.current) {
        toast.error(
          err instanceof Error
            ? err.message
            : translate('auto.components.settings.SshPane.c2a69510e3', 'Failed to remove target')
        )
      }
    }
  }

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
      toast.error(
        err instanceof Error
          ? err.message
          : translate('auto.components.settings.SshPane.e95d5ae10e', 'Connection failed')
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

  const handleTerminateSessions = async (targetId: string): Promise<void> => {
    try {
      await terminateSessionsWithReconnect(targetId)
      toast.success(
        translate('auto.components.settings.SshPane.90e308c98b', 'Remote terminals ended')
      )
    } catch (err) {
      toast.error(
        err instanceof Error
          ? err.message
          : translate(
              'auto.components.settings.SshPane.025e107643',
              'Failed to end remote terminals'
            )
      )
    }
  }

  const handleResetRelay = async (targetId: string): Promise<void> => {
    try {
      await window.api.ssh.resetRelay({ targetId })
      if (mountedRef.current) {
        toast.success(
          translate('auto.components.settings.SshPane.db2e48975e', 'Remote relay reset')
        )
      }
      await loadTargets()
    } catch (err) {
      if (mountedRef.current) {
        toast.error(
          err instanceof Error
            ? err.message
            : translate(
                'auto.components.settings.SshPane.2c4ee7332b',
                'Failed to reset remote relay'
              )
        )
      }
    }
  }

  const handleTest = async (targetId: string): Promise<void> => {
    setTestingIds((prev) => new Set(prev).add(targetId))
    try {
      const result = await window.api.ssh.testConnection({ targetId })
      recordFeatureInteraction('ssh')
      if (mountedRef.current) {
        if (result.success) {
          toast.success(
            translate('auto.components.settings.SshPane.81d08bcddf', 'Connection successful')
          )
        } else {
          toast.error(
            result.error ??
              translate('auto.components.settings.SshPane.0cda732f43', 'Connection test failed')
          )
        }
      }
    } catch (err) {
      if (mountedRef.current) {
        toast.error(
          err instanceof Error
            ? err.message
            : translate('auto.components.settings.SshPane.68c13b4589', 'Test failed')
        )
      }
    } finally {
      if (mountedRef.current) {
        setTestingIds((prev) => {
          const next = new Set(prev)
          next.delete(targetId)
          return next
        })
      }
    }
  }

  const handleImport = async (): Promise<void> => {
    try {
      // Why: the explicit Import action re-adopts every ~/.ssh/config host,
      // including ones the user previously deleted — clear tombstones so a
      // deliberate re-import can bring them back.
      const synced = (await window.api.ssh.importConfig({ reAdopt: true })) as SshTarget[]
      recordFeatureInteraction('ssh')
      if (mountedRef.current) {
        if (synced.length === 0) {
          toast('~/.ssh/config already in sync')
        } else {
          toast.success(
            translate(
              'auto.components.settings.SshPane.f8050f6307',
              'Synced {{value0}} server{{value1}}',
              { value0: synced.length, value1: synced.length > 1 ? 's' : '' }
            )
          )
        }
      }
      await loadTargets()
    } catch (err) {
      if (mountedRef.current) {
        toast.error(
          err instanceof Error
            ? err.message
            : translate('auto.components.settings.SshPane.f495689b82', 'Import failed')
        )
      }
    }
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
          {!showForm ? (
            <Button
              variant="outline"
              size="xs"
              onClick={() => {
                setEditingId(null)
                setForm(EMPTY_FORM)
                setShowForm(true)
              }}
              className="gap-1.5"
            >
              <Plus className="size-3" />
              {translate('auto.components.settings.SshPane.639ceb3698', 'Add Target')}
            </Button>
          ) : null}
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
            {targets.length === 0 && !showForm ? (
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
                    onRemove={(id) => requestRemove({ id, label: target.label })}
                  />
                ))}
              </div>
            )}

            {/* Add/Edit form */}
            {showForm ? (
              <SshTargetForm
                editingId={editingId}
                form={form}
                onFormChange={setForm}
                onSave={() => void handleSave()}
                onCancel={cancelForm}
              />
            ) : null}
          </>
        )}
      </SshTargetDestructiveActions>
    </div>
  )
}
