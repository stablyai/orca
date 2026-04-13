import { useCallback, useEffect, useState } from 'react'
import { toast } from 'sonner'
import { Plus, Upload } from 'lucide-react'
import type { SshTarget } from '../../../../shared/ssh-types'
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
  const [testing, setTesting] = useState<string | null>(null)
  const [pendingRemove, setPendingRemove] = useState<{ id: string; label: string } | null>(null)

  const loadTargets = useCallback(async () => {
    try {
      const result = (await window.api.ssh.listTargets()) as SshTarget[]
      setTargets(result)
    } catch {
      toast.error('Failed to load SSH targets')
    }
  }, [])

  useEffect(() => {
    void loadTargets()
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

    const target = {
      label: form.label.trim() || `${form.username}@${form.host}`,
      host: form.host.trim(),
      port,
      username: form.username.trim(),
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

  const handleRemove = async (id: string): Promise<void> => {
    try {
      // Why: disconnect any non-disconnected connection, including transitional
      // states (connecting, reconnecting, deploying-relay). Leaving these alive
      // would orphan SSH connections with providers registered for a removed target.
      const state = sshConnectionStates.get(id)
      if (state && state.status !== 'disconnected') {
        await window.api.ssh.disconnect({ targetId: id })
      }
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
      host: target.host,
      port: String(target.port),
      username: target.username,
      identityFile: target.identityFile ?? '',
      proxyCommand: target.proxyCommand ?? '',
      jumpHost: target.jumpHost ?? ''
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

  const handleTest = async (targetId: string): Promise<void> => {
    setTesting(targetId)
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
      setTesting(null)
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
              testing={testing === target.id}
              onConnect={(id) => void handleConnect(id)}
              onDisconnect={(id) => void handleDisconnect(id)}
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
              This will remove the target and disconnect any active sessions.
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
    </div>
  )
}
