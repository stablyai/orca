/* oxlint-disable max-lines -- Why: co-locates forwarded list, detected list, modal form, and
per-entry actions in one file to keep the data flow straightforward. */
import React, { useCallback, useMemo, useState } from 'react'
import { ExternalLink, Copy, Trash2, Plus, Unplug, ChevronRight, Pencil } from 'lucide-react'
import { useAppStore } from '@/store'
import { useActiveWorktree, useRepoById } from '@/store/selectors'
import { cn } from '@/lib/utils'
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogDescription
} from '@/components/ui/dialog'
import { Button } from '@/components/ui/button'
import type { PortForwardEntry, DetectedPort } from '../../../../shared/ssh-types'

// Why: ports < 1024 require root to bind on the local machine. Remap them
// to a high port so the default "Forward" action doesn't fail with EACCES.
function safeLocalPort(remotePort: number): number {
  if (remotePort < 1024) {
    return remotePort + 10000
  }
  return remotePort
}

const HTTP_PORTS = new Set([80, 443, 3000, 3001, 4200, 5000, 5173, 5174, 8000, 8080, 8443, 8888])
const HTTPS_PORTS = new Set([443, 8443])

// Why: the scanner reports numeric addresses (127.0.0.1, 0.0.0.0, ::1, ::)
// while forwards typically use "localhost". Normalize all loopback/wildcard
// variants to "localhost" so dedup matching works regardless of representation.
const LOOPBACK_HOSTS = new Set(['localhost', '127.0.0.1', '::1', '0.0.0.0', '::'])
function normalizeHost(host: string | undefined): string {
  if (!host || LOOPBACK_HOSTS.has(host)) {
    return 'localhost'
  }
  return host
}

type PortForwardDialogState =
  | { mode: 'closed' }
  | {
      mode: 'add'
      defaults: { remotePort?: number; remoteHost?: string; label?: string; targetId?: string }
    }
  | { mode: 'edit'; entry: PortForwardEntry }

export default function PortsPanel(): React.JSX.Element {
  const portForwardsByConnection = useAppStore((s) => s.portForwardsByConnection)
  const detectedPortsByConnection = useAppStore((s) => s.detectedPortsByConnection)
  const sshConnectionStates = useAppStore((s) => s.sshConnectionStates)
  // Why: scope the panel to the active worktree's SSH connection so
  // actions target the correct machine and the disconnected state
  // reflects the active worktree, not some other SSH session.
  const activeWorktree = useActiveWorktree()
  const activeRepo = useRepoById(activeWorktree?.repoId ?? null)
  const activeConnectionId = activeRepo?.connectionId ?? null

  const isDisconnected = activeConnectionId
    ? sshConnectionStates.get(activeConnectionId)?.status !== 'connected'
    : true

  const allForwards = useMemo(() => {
    if (!activeConnectionId) {
      return []
    }
    return portForwardsByConnection[activeConnectionId] ?? []
  }, [portForwardsByConnection, activeConnectionId])

  const forwardedKeys = useMemo(() => {
    const set = new Set<string>()
    for (const f of allForwards) {
      set.add(`${normalizeHost(f.remoteHost)}:${f.remotePort}`)
    }
    return set
  }, [allForwards])

  const allDetected = useMemo(() => {
    if (!activeConnectionId) {
      return []
    }
    const ports = detectedPortsByConnection[activeConnectionId] ?? []
    return ports
      .filter((p) => !forwardedKeys.has(`${normalizeHost(p.host)}:${p.port}`))
      .map((p) => ({ ...p, targetId: activeConnectionId }))
      .sort((a, b) => a.port - b.port)
  }, [detectedPortsByConnection, activeConnectionId, forwardedKeys])

  const [forwardedCollapsed, setForwardedCollapsed] = useState(false)
  const [detectedCollapsed, setDetectedCollapsed] = useState(false)
  const [dialogState, setDialogState] = useState<PortForwardDialogState>({ mode: 'closed' })

  const handleForwardDetected = useCallback((port: DetectedPort & { targetId: string }) => {
    setDialogState({
      mode: 'add',
      defaults: {
        remotePort: port.port,
        remoteHost: normalizeHost(port.host),
        label: port.processName,
        targetId: port.targetId
      }
    })
  }, [])

  const handleEdit = useCallback((entry: PortForwardEntry) => {
    setDialogState({ mode: 'edit', entry })
  }, [])

  const handleDialogClose = useCallback(() => {
    setDialogState({ mode: 'closed' })
  }, [])

  if (isDisconnected) {
    return (
      <div className="flex flex-col items-center justify-center h-full px-4 text-center text-muted-foreground">
        <Unplug size={32} className="mb-3 opacity-50" />
        <p className="text-sm font-medium">SSH connection lost</p>
        <p className="text-xs mt-1">Reconnecting...</p>
      </div>
    )
  }

  return (
    <div className="flex flex-col h-full overflow-y-auto scrollbar-sleek">
      {/* Header */}
      <div className="flex items-center justify-between px-3 py-2 border-b border-border">
        <span className="text-[11px] font-semibold uppercase tracking-wider text-muted-foreground">
          Ports
        </span>
        <button
          type="button"
          className="flex items-center gap-1 text-xs text-muted-foreground hover:text-foreground transition-colors"
          onClick={() =>
            setDialogState({ mode: 'add', defaults: { targetId: activeConnectionId ?? undefined } })
          }
        >
          <Plus size={14} />
          Add
        </button>
      </div>

      {/* Forwarded ports */}
      {allForwards.length > 0 && (
        <div className="px-3 pt-2">
          <button
            type="button"
            className="flex items-center gap-1 w-full text-left mb-1"
            onClick={() => setForwardedCollapsed((v) => !v)}
          >
            <ChevronRight
              size={12}
              className={cn(
                'text-muted-foreground transition-transform',
                !forwardedCollapsed && 'rotate-90'
              )}
            />
            <span className="text-[10px] font-semibold uppercase tracking-wider text-muted-foreground">
              Forwarded
            </span>
            <span className="text-[10px] text-muted-foreground/60 ml-1">{allForwards.length}</span>
          </button>
          {!forwardedCollapsed &&
            allForwards.map((entry) => (
              <ForwardedPortRow key={entry.id} entry={entry} onEdit={() => handleEdit(entry)} />
            ))}
        </div>
      )}

      {/* Detected ports */}
      {allDetected.length > 0 && (
        <div className="px-3 pt-2">
          <button
            type="button"
            className="flex items-center gap-1 w-full text-left mb-1"
            onClick={() => setDetectedCollapsed((v) => !v)}
          >
            <ChevronRight
              size={12}
              className={cn(
                'text-muted-foreground transition-transform',
                !detectedCollapsed && 'rotate-90'
              )}
            />
            <span className="text-[10px] font-semibold uppercase tracking-wider text-muted-foreground">
              Detected
            </span>
            <span className="text-[10px] text-muted-foreground/60 ml-1">{allDetected.length}</span>
          </button>
          {!detectedCollapsed &&
            allDetected.map((port) => (
              <DetectedPortRow
                key={`${port.targetId}-${port.host}-${port.port}`}
                port={port}
                onForward={() => handleForwardDetected(port)}
              />
            ))}
        </div>
      )}

      {/* Empty state */}
      {allForwards.length === 0 && allDetected.length === 0 && (
        <div className="flex flex-col items-center justify-center flex-1 px-4 text-center text-muted-foreground">
          <p className="text-sm">No forwarded ports</p>
          <p className="text-xs mt-1 mb-3">
            Forward a port to access remote services on your local machine.
          </p>
          <button
            type="button"
            className="text-xs px-3 py-1.5 rounded bg-primary text-primary-foreground hover:bg-primary/90 transition-colors"
            onClick={() =>
              setDialogState({
                mode: 'add',
                defaults: { targetId: activeConnectionId ?? undefined }
              })
            }
          >
            Forward a Port
          </button>
        </div>
      )}

      <PortForwardDialog
        state={dialogState}
        activeConnectionId={activeConnectionId}
        onClose={handleDialogClose}
      />
    </div>
  )
}

function ForwardedPortRow({
  entry,
  onEdit
}: {
  entry: PortForwardEntry
  onEdit: () => void
}): React.JSX.Element {
  const [removing, setRemoving] = useState(false)

  const handleRemove = useCallback(async () => {
    setRemoving(true)
    try {
      await window.api.ssh.removePortForward({ id: entry.id })
    } catch {
      // broadcast will update state
    }
    setRemoving(false)
  }, [entry.id])

  const handleCopy = useCallback(() => {
    // Why: use 127.0.0.1 instead of localhost because the local TCP listener
    // binds to 127.0.0.1 specifically. On systems that resolve localhost to
    // ::1 first, "localhost:<port>" would fail even though the forward is up.
    void window.api.ui.writeClipboardText(`127.0.0.1:${entry.localPort}`)
  }, [entry.localPort])

  const handleOpenBrowser = useCallback(() => {
    // Why: the protocol hint comes from the remote port (the actual service),
    // not the local port which may be an arbitrary remap.
    const protocol = HTTPS_PORTS.has(entry.remotePort) ? 'https' : 'http'
    void window.api.shell.openUrl(`${protocol}://127.0.0.1:${entry.localPort}`)
  }, [entry.localPort, entry.remotePort])

  const isHttpPort = HTTP_PORTS.has(entry.remotePort)

  return (
    <div className="group flex items-center gap-2 py-1 px-1 -mx-1 rounded hover:bg-accent/50 transition-colors">
      <div className="flex-1 min-w-0">
        <div className="flex items-center gap-1.5">
          {entry.label && (
            <span className="text-xs font-medium text-foreground truncate">{entry.label}</span>
          )}
          <span
            className={cn(
              'text-xs text-muted-foreground truncate',
              !entry.label && 'text-foreground'
            )}
          >
            :{entry.localPort} → :{entry.remotePort}
          </span>
        </div>
      </div>
      <div className="flex items-center gap-0.5 opacity-0 group-hover:opacity-100 transition-opacity">
        {isHttpPort && (
          <button
            type="button"
            className="p-1 rounded hover:bg-accent transition-colors text-muted-foreground hover:text-foreground"
            onClick={handleOpenBrowser}
            title="Open in Browser"
          >
            <ExternalLink size={13} />
          </button>
        )}
        <button
          type="button"
          className="p-1 rounded hover:bg-accent transition-colors text-muted-foreground hover:text-foreground"
          onClick={handleCopy}
          title="Copy Address"
        >
          <Copy size={13} />
        </button>
        <button
          type="button"
          className="p-1 rounded hover:bg-accent transition-colors text-muted-foreground hover:text-foreground"
          onClick={onEdit}
          title="Edit"
        >
          <Pencil size={13} />
        </button>
        <button
          type="button"
          className={cn(
            'p-1 rounded hover:bg-accent transition-colors text-muted-foreground hover:text-foreground',
            removing && 'opacity-50'
          )}
          onClick={handleRemove}
          disabled={removing}
          title="Remove"
        >
          <Trash2 size={13} />
        </button>
      </div>
    </div>
  )
}

function DetectedPortRow({
  port,
  onForward
}: {
  port: DetectedPort & { targetId: string }
  onForward: () => void
}): React.JSX.Element {
  return (
    <div className="group flex items-center gap-2 py-1 px-1 -mx-1 rounded hover:bg-accent/50 transition-colors">
      <div className="flex-1 min-w-0">
        <span className="text-xs text-foreground">:{port.port}</span>
        {port.processName && (
          <span className="text-xs text-muted-foreground ml-1.5">{port.processName}</span>
        )}
      </div>
      <button
        type="button"
        className="text-[11px] px-2 py-0.5 rounded opacity-0 group-hover:opacity-100 transition-opacity bg-accent hover:bg-accent/80 text-foreground"
        onClick={onForward}
      >
        Forward
      </button>
    </div>
  )
}

function digitsOnly(value: string): string {
  return value.replace(/\D/g, '')
}

const INPUT_CLASS =
  'block w-full mt-0.5 px-2 py-1.5 text-xs rounded border border-border bg-background text-foreground focus:outline-none focus:ring-1 focus:ring-ring'

function PortForwardDialog({
  state,
  activeConnectionId,
  onClose
}: {
  state: PortForwardDialogState
  activeConnectionId: string | null
  onClose: () => void
}): React.JSX.Element {
  const isOpen = state.mode !== 'closed'
  const isEdit = state.mode === 'edit'

  const initialRemotePort =
    state.mode === 'edit'
      ? state.entry.remotePort.toString()
      : state.mode === 'add'
        ? (state.defaults.remotePort?.toString() ?? '')
        : ''

  const initialLocalPort =
    state.mode === 'edit'
      ? state.entry.localPort.toString()
      : state.mode === 'add' && state.defaults.remotePort != null
        ? safeLocalPort(state.defaults.remotePort).toString()
        : ''

  const initialRemoteHost =
    state.mode === 'edit'
      ? state.entry.remoteHost
      : state.mode === 'add'
        ? (state.defaults.remoteHost ?? 'localhost')
        : 'localhost'

  const initialLabel =
    state.mode === 'edit'
      ? (state.entry.label ?? '')
      : state.mode === 'add'
        ? (state.defaults.label ?? '')
        : ''

  // Why: capture the target at dialog-open time via defaults.targetId so
  // switching worktrees while the dialog is open doesn't redirect the
  // forward to the wrong SSH connection.
  const targetId =
    state.mode === 'edit'
      ? state.entry.connectionId
      : state.mode === 'add'
        ? (state.defaults.targetId ?? activeConnectionId ?? '')
        : (activeConnectionId ?? '')

  return (
    <Dialog
      open={isOpen}
      onOpenChange={(open) => {
        if (!open) {
          onClose()
        }
      }}
    >
      <DialogContent showCloseButton={false} className="max-w-[340px]">
        <DialogHeader>
          <DialogTitle className="text-sm">
            {isEdit ? 'Edit Port Forward' : 'Forward a Port'}
          </DialogTitle>
          <DialogDescription className="text-xs">
            {isEdit
              ? 'Update the port forwarding configuration.'
              : 'Forward a remote port to your local machine.'}
          </DialogDescription>
        </DialogHeader>
        {isOpen && (
          <PortForwardForm
            key={
              state.mode === 'edit'
                ? `edit-${state.entry.id}`
                : `add-${targetId}-${initialRemotePort}-${initialRemoteHost}`
            }
            mode={state.mode}
            editId={state.mode === 'edit' ? state.entry.id : undefined}
            initialRemotePort={initialRemotePort}
            initialLocalPort={initialLocalPort}
            initialRemoteHost={initialRemoteHost}
            initialLabel={initialLabel}
            targetId={targetId}
            onClose={onClose}
          />
        )}
      </DialogContent>
    </Dialog>
  )
}

function PortForwardForm({
  mode,
  editId,
  initialRemotePort,
  initialLocalPort,
  initialRemoteHost,
  initialLabel,
  targetId,
  onClose
}: {
  mode: 'add' | 'edit'
  editId?: string
  initialRemotePort: string
  initialLocalPort: string
  initialRemoteHost: string
  initialLabel: string
  targetId: string
  onClose: () => void
}): React.JSX.Element {
  const [remotePort, setRemotePort] = useState(initialRemotePort)
  const [localPort, setLocalPort] = useState(initialLocalPort)
  const [remoteHost, setRemoteHost] = useState(initialRemoteHost)
  const [label, setLabel] = useState(initialLabel)
  const [error, setError] = useState<string | null>(null)
  const [submitting, setSubmitting] = useState(false)

  const handleSubmit = useCallback(
    async (e: React.FormEvent) => {
      e.preventDefault()
      setError(null)

      const rPort = parseInt(remotePort, 10)
      const lPort = parseInt(localPort || remotePort, 10)

      if (isNaN(rPort) || rPort < 1 || rPort > 65535) {
        setError('Remote port must be 1\u201365535')
        return
      }
      if (isNaN(lPort) || lPort < 1 || lPort > 65535) {
        setError('Local port must be 1\u201365535')
        return
      }

      setSubmitting(true)
      try {
        await (mode === 'edit' && editId
          ? window.api.ssh.updatePortForward({
              id: editId,
              targetId,
              localPort: lPort,
              remoteHost: remoteHost || 'localhost',
              remotePort: rPort,
              label: label || undefined
            })
          : window.api.ssh.addPortForward({
              targetId,
              localPort: lPort,
              remoteHost: remoteHost || 'localhost',
              remotePort: rPort,
              label: label || undefined
            }))
        onClose()
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err)
        if (msg.includes('EADDRINUSE') || msg.includes('already in use')) {
          setError(`Port ${lPort} is already in use. Choose a different local port.`)
        } else if (msg.includes('EACCES') || msg.includes('permission denied')) {
          setError(`Port ${lPort} requires elevated privileges. Use a local port \u2265 1024.`)
        } else {
          setError(msg)
        }
      }
      setSubmitting(false)
    },
    [mode, editId, remotePort, localPort, remoteHost, label, targetId, onClose]
  )

  return (
    <form onSubmit={handleSubmit} className="space-y-3">
      <div className="space-y-2">
        <label className="block">
          <span className="text-[11px] text-muted-foreground">Remote Port</span>
          <input
            type="text"
            inputMode="numeric"
            value={remotePort}
            onChange={(e) => {
              const val = digitsOnly(e.target.value)
              setRemotePort(val)
              const prev = parseInt(remotePort, 10)
              const cur = parseInt(localPort, 10)
              if (!localPort || cur === prev || cur === safeLocalPort(prev)) {
                const parsed = parseInt(val, 10)
                setLocalPort(isNaN(parsed) ? '' : safeLocalPort(parsed).toString())
              }
            }}
            className={INPUT_CLASS}
            placeholder="3000"
            autoFocus
            required
          />
        </label>

        <label className="block">
          <span className="text-[11px] text-muted-foreground">Local Port</span>
          <input
            type="text"
            inputMode="numeric"
            value={localPort}
            onChange={(e) => setLocalPort(digitsOnly(e.target.value))}
            className={INPUT_CLASS}
            placeholder="Same as remote"
          />
        </label>

        <label className="block">
          <span className="text-[11px] text-muted-foreground">Remote Host</span>
          <input
            type="text"
            value={remoteHost}
            onChange={(e) => setRemoteHost(e.target.value)}
            className={INPUT_CLASS}
            placeholder="localhost"
          />
        </label>

        <label className="block">
          <span className="text-[11px] text-muted-foreground">Label (optional)</span>
          <input
            type="text"
            value={label}
            onChange={(e) => setLabel(e.target.value)}
            className={INPUT_CLASS}
            placeholder="dev-server"
          />
        </label>
      </div>

      {error && <div className="text-[11px] text-destructive">{error}</div>}

      <div className="flex justify-end gap-2">
        <Button type="button" variant="outline" size="sm" onClick={onClose}>
          Cancel
        </Button>
        <Button type="submit" size="sm" disabled={submitting || !remotePort}>
          {submitting
            ? mode === 'edit'
              ? 'Saving...'
              : 'Forwarding...'
            : mode === 'edit'
              ? 'Save'
              : 'Forward'}
        </Button>
      </div>
    </form>
  )
}
