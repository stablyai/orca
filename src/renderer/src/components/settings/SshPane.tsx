import { useCallback, useEffect, useState } from 'react'
import { toast } from 'sonner'
import { Plus, Upload } from 'lucide-react'
import type { SshTarget } from '../../../../shared/ssh-types'
import { SSH_TERMINATE_RECONNECT_REQUIRED } from '../../../../shared/constants'
import { useAppStore } from '@/store'
import { Button } from '../ui/button'
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle
} from '../ui/dialog'
import type { SettingsSearchEntry } from './settings-search'
import { SshTargetCard } from './SshTargetCard'
import { SshTargetForm, EMPTY_FORM, type EditingTarget } from './SshTargetForm'

export const SSH_PANE_SEARCH_ENTRIES: SettingsSearchEntry[] = [
  {
    title: 'SSH Connections',
    description: 'Manage remote SSH targets.',
    keywords: ['ssh', 'remote', 'server', 'connection', 'host']
  },
  {
    title: 'Add SSH Target',
    description: 'Add a new remote SSH target.',
    keywords: ['ssh', 'add', 'new', 'target', 'host', 'server']
  },
  {
    title: 'Import from SSH Config',
    description: 'Import hosts from ~/.ssh/config.',
    keywords: ['ssh', 'import', 'config', 'hosts']
  },
  {
    title: 'Test Connection',
    description: 'Test connectivity to an SSH target.',
    keywords: ['ssh', 'test', 'connection', 'ping']
  }
]

type SshPaneProps = Record<string, never>

export function SshPane(_props: SshPaneProps): React.JSX.Element {
  const [targets, setTargets] = useState<SshTarget[]>([])
  // Why: connection states are already hydrated and kept up-to-date by the
  // global store (via useIpcEvents.ts). Reading from the store avoids
  // duplicating the onStateChanged listener and per-target getState IPC calls.
  const sshConnectionStates = useAppStore((s) => s.sshConnectionStates)
  const [showForm, setShowForm] = useState(false)
  const [editingId, setEditingId] = useState<string | null>(null)
  const [form, setForm] = useState<EditingTarget>(EMPTY_FORM)
  const [testingIds, setTestingIds] = useState<Set<string>>(new Set())
  const [pendingRemove, setPendingRemove] = useState<{ id: string; label: string } | null>(null)
  const [pendingTerminate, setPendingTerminate] = useState<{ id: string; label: string } | null>(
    null
  )

  const setSshTargetsMetadata = useAppStore((s) => s.setSshTargetsMetadata)

  const loadTargets = useCallback(
    async (opts?: { signal?: AbortSignal }) => {
      try {
        const result = (await window.api.ssh.listTargets()) as SshTarget[]
        if (opts?.signal?.aborted) {
          return
        }
        setTargets(result)
        setSshTargetsMetadata(result)
      } catch {
        if (!opts?.signal?.aborted) {
          toast.error('Failed to load SSH targets')
        }
      }
    },
    [setSshTargetsMetadata]
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

    const graceSeconds = parseInt(form.relayGracePeriodSeconds, 10)
    if (isNaN(graceSeconds) || graceSeconds < 60 || graceSeconds > 3600) {
      toast.error('Relay grace period must be between 60 and 3600 seconds')
      return
    }
    const remoteGraceSeconds = parseInt(form.remoteWorkspaceSyncGracePeriodSeconds, 10)
    if (
      form.remoteWorkspaceSyncEnabled &&
      (isNaN(remoteGraceSeconds) || remoteGraceSeconds < 0 || remoteGraceSeconds > 3600)
    ) {
      toast.error('Synced relay grace period must be between 0 and 3600 seconds')
      return
    }

    const target = {
      label: form.label.trim() || `${form.username}@${form.host}`,
      configHost: form.configHost.trim() || form.host.trim(),
      host: form.host.trim(),
      port,
      username: form.username.trim(),
      relayGracePeriodSeconds: graceSeconds,
      remoteWorkspaceSyncEnabled: form.remoteWorkspaceSyncEnabled,
      remoteWorkspaceSyncGracePeriodSeconds: form.remoteWorkspaceSyncEnabled
        ? remoteGraceSeconds
        : 300,
      ...(form.identityFile.trim() ? { identityFile: form.identityFile.trim() } : {}),
      ...(form.proxyCommand.trim() ? { proxyCommand: form.proxyCommand.trim() } : {}),
      ...(form.jumpHost.trim() ? { jumpHost: form.jumpHost.trim() } : {})
    }

    try {
      if (editingId) {
        await window.api.ssh.updateTarget({ id: editingId, updates: target })
        toast.success('Target updated')
      } else {
        await window.api.ssh.addTarget({ target })
        toast.success('Target added')
      }
      setShowForm(false)
      setEditingId(null)
      setForm(EMPTY_FORM)
      await loadTargets()
    } catch (err) {
      toast.error(err instanceof Error ? err.message : 'Failed to save target')
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
      // Why: removing a target is destructive even after non-destructive
      // disconnect, when remote PTYs can still be alive in the grace window.
      await terminateSessionsWithReconnect(id)
      await window.api.ssh.removeTarget({ id })
      toast.success('Target removed')
      await loadTargets()
    } catch (err) {
      toast.error(err instanceof Error ? err.message : 'Failed to remove target')
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
      relayGracePeriodSeconds: String(target.relayGracePeriodSeconds ?? 300),
      remoteWorkspaceSyncEnabled: target.remoteWorkspaceSyncEnabled === true,
      remoteWorkspaceSyncGracePeriodSeconds: String(
        target.remoteWorkspaceSyncGracePeriodSeconds ?? 300
      )
    })
    setShowForm(true)
  }

  const handleConnect = async (targetId: string): Promise<void> => {
    try {
      await window.api.ssh.connect({ targetId })
    } catch (err) {
      toast.error(err instanceof Error ? err.message : 'Connection failed')
    }
  }

  const handleDisconnect = async (targetId: string): Promise<void> => {
    try {
      await window.api.ssh.disconnect({ targetId })
    } catch (err) {
      toast.error(err instanceof Error ? err.message : 'Disconnect failed')
    }
  }

  const handleTerminateSessions = async (targetId: string): Promise<void> => {
    try {
      await terminateSessionsWithReconnect(targetId)
      toast.success('Remote sessions terminated')
    } catch (err) {
      toast.error(err instanceof Error ? err.message : 'Failed to terminate sessions')
    }
  }

  const handleTest = async (targetId: string): Promise<void> => {
    setTestingIds((prev) => new Set(prev).add(targetId))
    try {
      const result = await window.api.ssh.testConnection({ targetId })
      if (result.success) {
        toast.success('Connection successful')
      } else {
        toast.error(result.error ?? 'Connection test failed')
      }
    } catch (err) {
      toast.error(err instanceof Error ? err.message : 'Test failed')
    } finally {
      setTestingIds((prev) => {
        const next = new Set(prev)
        next.delete(targetId)
        return next
      })
    }
  }

  const handleImport = async (): Promise<void> => {
    try {
      const imported = (await window.api.ssh.importConfig()) as SshTarget[]
      if (imported.length === 0) {
        toast('No new hosts found in ~/.ssh/config')
      } else {
        toast.success(`Imported ${imported.length} host${imported.length > 1 ? 's' : ''}`)
      }
      await loadTargets()
    } catch (err) {
      toast.error(err instanceof Error ? err.message : 'Import failed')
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
              onConnect={(id) => void handleConnect(id)}
              onDisconnect={(id) => void handleDisconnect(id)}
              onTerminateSessions={(id) => setPendingTerminate({ id, label: target.label })}
              onTest={(id) => void handleTest(id)}
              onEdit={handleEdit}
              onRemove={(id) => setPendingRemove({ id, label: target.label })}
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

      {/* Remove confirmation dialog */}
      <Dialog
        open={!!pendingRemove}
        onOpenChange={(open) => {
          if (!open) {
            setPendingRemove(null)
          }
        }}
      >
        <DialogContent className="max-w-sm sm:max-w-sm" showCloseButton={false}>
          <DialogHeader>
            <DialogTitle className="text-sm">Remove SSH Target</DialogTitle>
            <DialogDescription className="text-xs">
              This will remove the target and terminate any active remote sessions.
            </DialogDescription>
          </DialogHeader>

          {pendingRemove ? (
            <div className="rounded-md border border-border/70 bg-muted/35 px-3 py-2 text-xs">
              <div className="break-all text-muted-foreground">{pendingRemove.label}</div>
            </div>
          ) : null}

          <DialogFooter>
            <Button variant="outline" onClick={() => setPendingRemove(null)}>
              Cancel
            </Button>
            <Button
              variant="destructive"
              onClick={() => {
                if (pendingRemove) {
                  void handleRemove(pendingRemove.id)
                  setPendingRemove(null)
                }
              }}
            >
              Remove
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* Terminate confirmation dialog */}
      <Dialog
        open={!!pendingTerminate}
        onOpenChange={(open) => {
          if (!open) {
            setPendingTerminate(null)
          }
        }}
      >
        <DialogContent className="max-w-sm sm:max-w-sm" showCloseButton={false}>
          <DialogHeader>
            <DialogTitle className="text-sm">Terminate Remote Sessions</DialogTitle>
            <DialogDescription className="text-xs">
              This will kill active remote terminals for this SSH target.
            </DialogDescription>
          </DialogHeader>

          {pendingTerminate ? (
            <div className="rounded-md border border-border/70 bg-muted/35 px-3 py-2 text-xs">
              <div className="break-all text-muted-foreground">{pendingTerminate.label}</div>
            </div>
          ) : null}

          <DialogFooter>
            <Button variant="outline" onClick={() => setPendingTerminate(null)}>
              Cancel
            </Button>
            <Button
              variant="destructive"
              onClick={() => {
                if (pendingTerminate) {
                  void handleTerminateSessions(pendingTerminate.id)
                  setPendingTerminate(null)
                }
              }}
            >
              Terminate
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  )
}
