import { useCallback, useEffect, useState } from 'react'
import { toast } from 'sonner'
import { Plus, Upload } from 'lucide-react'
import {
  DEFAULT_SSH_RELAY_GRACE_PERIOD_SECONDS,
  MAX_SSH_RELAY_GRACE_PERIOD_SECONDS,
  MIN_SSH_RELAY_GRACE_PERIOD_SECONDS,
  type SshTarget
} from '../../../../shared/ssh-types'
import { SSH_TERMINATE_RECONNECT_REQUIRED } from '../../../../shared/constants'
import { useAppStore } from '@/store'
import { useMountedRef } from '@/hooks/useMountedRef'
import { Button } from '../ui/button'
import { removeSshTargetWithBestEffortCleanup } from './ssh-target-remove'
import { SshTargetCard } from './SshTargetCard'
import { SshTargetDestructiveActions } from './SshTargetDestructiveActions'
import { SshTargetForm, EMPTY_FORM, type EditingTarget } from './SshTargetForm'
export { SSH_PANE_SEARCH_ENTRIES } from './ssh-search'

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
          toast.error('Failed to load SSH targets')
        }
      }
    },
    [mountedRef, setSshTargetsMetadata]
  )

  useEffect(() => {
    const abortController = new AbortController()
    void loadTargets({ signal: abortController.signal })
    return () => abortController.abort()
  }, [loadTargets])

  const handleSave = async (): Promise<void> => {
    if (!form.host.trim() || !form.username.trim()) {
      toast.error('Host and username are required')
      return
    }

    const port = parseInt(form.port, 10)
    if (isNaN(port) || port < 1 || port > 65535) {
      toast.error('Port must be between 1 and 65535')
      return
    }

    const graceSeconds = form.relayKeepAliveUntilReset
      ? 0
      : parseInt(form.relayGracePeriodSeconds, 10)
    if (
      !form.relayKeepAliveUntilReset &&
      (isNaN(graceSeconds) ||
        graceSeconds < MIN_SSH_RELAY_GRACE_PERIOD_SECONDS ||
        graceSeconds > MAX_SSH_RELAY_GRACE_PERIOD_SECONDS)
    ) {
      toast.error(
        `Relay grace period must be between 60 and ${MAX_SSH_RELAY_GRACE_PERIOD_SECONDS} seconds, or choose keep alive until reset`
      )
      return
    }

    const target = {
      label: form.label.trim() || `${form.username}@${form.host}`,
      configHost: form.configHost.trim() || form.host.trim(),
      host: form.host.trim(),
      port,
      username: form.username.trim(),
      relayGracePeriodSeconds: graceSeconds,
      ...(form.identityFile.trim() ? { identityFile: form.identityFile.trim() } : {}),
      ...(form.proxyCommand.trim() ? { proxyCommand: form.proxyCommand.trim() } : {}),
      ...(form.jumpHost.trim() ? { jumpHost: form.jumpHost.trim() } : {})
    }

    try {
      await (editingId
        ? window.api.ssh.updateTarget({ id: editingId, updates: target })
        : window.api.ssh.addTarget({ target }))
      recordFeatureInteraction('ssh')
      if (!mountedRef.current) {
        return
      }
      toast.success(editingId ? 'Target updated' : 'Target added')
      setShowForm(false)
      setEditingId(null)
      setForm(EMPTY_FORM)
      await loadTargets()
    } catch (err) {
      if (mountedRef.current) {
        toast.error(err instanceof Error ? err.message : 'Failed to save target')
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
        toast.success('Target removed')
      }
      await loadTargets()
    } catch (err) {
      if (mountedRef.current) {
        toast.error(err instanceof Error ? err.message : 'Failed to remove target')
      }
    }
  }

  const handleEdit = (target: SshTarget): void => {
    setEditingId(target.id)
    setForm({
      label: target.label,
      configHost: target.configHost ?? target.host,
      host: target.host,
      port: String(target.port),
      username: target.username,
      identityFile: target.identityFile ?? '',
      proxyCommand: target.proxyCommand ?? '',
      jumpHost: target.jumpHost ?? '',
      relayGracePeriodSeconds: String(
        target.relayGracePeriodSeconds === 0
          ? DEFAULT_SSH_RELAY_GRACE_PERIOD_SECONDS
          : (target.relayGracePeriodSeconds ?? DEFAULT_SSH_RELAY_GRACE_PERIOD_SECONDS)
      ),
      relayKeepAliveUntilReset: target.relayGracePeriodSeconds === 0
    })
    setShowForm(true)
  }

  const handleConnect = async (targetId: string): Promise<void> => {
    try {
      await window.api.ssh.connect({ targetId })
      recordFeatureInteraction('ssh')
    } catch (err) {
      toast.error(err instanceof Error ? err.message : 'Connection failed')
    }
  }

  const handleDisconnect = async (targetId: string): Promise<void> => {
    try {
      await window.api.ssh.disconnect({ targetId })
      recordFeatureInteraction('ssh')
    } catch (err) {
      toast.error(err instanceof Error ? err.message : 'Disconnect failed')
    }
  }

  const handleTerminateSessions = async (targetId: string): Promise<void> => {
    try {
      await terminateSessionsWithReconnect(targetId)
      toast.success('Remote terminals ended')
    } catch (err) {
      toast.error(err instanceof Error ? err.message : 'Failed to end remote terminals')
    }
  }

  const handleResetRelay = async (targetId: string): Promise<void> => {
    try {
      await window.api.ssh.resetRelay({ targetId })
      if (mountedRef.current) {
        toast.success('Remote relay reset')
      }
      await loadTargets()
    } catch (err) {
      if (mountedRef.current) {
        toast.error(err instanceof Error ? err.message : 'Failed to reset remote relay')
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
          toast.success('Connection successful')
        } else {
          toast.error(result.error ?? 'Connection test failed')
        }
      }
    } catch (err) {
      if (mountedRef.current) {
        toast.error(err instanceof Error ? err.message : 'Test failed')
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
      const imported = (await window.api.ssh.importConfig()) as SshTarget[]
      recordFeatureInteraction('ssh')
      if (mountedRef.current) {
        if (imported.length === 0) {
          toast('No new hosts found in ~/.ssh/config')
        } else {
          toast.success(`Imported ${imported.length} host${imported.length > 1 ? 's' : ''}`)
        }
      }
      await loadTargets()
    } catch (err) {
      if (mountedRef.current) {
        toast.error(err instanceof Error ? err.message : 'Import failed')
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
          <p className="text-sm font-medium">Targets</p>
          <p className="text-xs text-muted-foreground">
            Add a remote host to connect to it in Orca.
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
            Import
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
              Add Target
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
                No SSH targets configured.
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
