import React, { useCallback, useState } from 'react'
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle
} from '@/components/ui/dialog'
import { Button } from '@/components/ui/button'
import type { PortForwardEntry } from '../../../../shared/ssh-types'
import { translate } from '@/i18n/i18n'

// Why: ports < 1024 require root to bind on the local machine. Remap them
// to a high port so the default "Forward" action doesn't fail with EACCES.
function safeLocalPort(remotePort: number): number {
  if (remotePort < 1024) {
    return remotePort + 10000
  }
  return remotePort
}

export type PortForwardDialogState =
  | { mode: 'closed' }
  | {
      mode: 'add'
      defaults: { remotePort?: number; remoteHost?: string; label?: string; targetId?: string }
    }
  | { mode: 'edit'; entry: PortForwardEntry }

function digitsOnly(value: string): string {
  return value.replace(/\D/g, '')
}

const INPUT_CLASS =
  'block w-full mt-0.5 px-2 py-1.5 text-xs rounded border border-border bg-background text-foreground focus:outline-none focus:ring-1 focus:ring-ring'

export function SshPortForwardDialog({
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
            {isEdit
              ? translate(
                  'auto.components.right.sidebar.PortsPanel.80206251c8',
                  'Edit Port Forward'
                )
              : translate('auto.components.right.sidebar.PortsPanel.907eb53ed2', 'Forward a Port')}
          </DialogTitle>
          <DialogDescription className="text-xs">
            {isEdit
              ? translate(
                  'auto.components.right.sidebar.PortsPanel.10360598a4',
                  'Update the port forwarding configuration.'
                )
              : translate(
                  'auto.components.right.sidebar.PortsPanel.31e80cff2d',
                  'Forward a remote port to your local machine.'
                )}
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

      const rPort = Number.parseInt(remotePort, 10)
      const lPort = Number.parseInt(localPort || remotePort, 10)

      if (Number.isNaN(rPort) || rPort < 1 || rPort > 65535) {
        setError('Remote port must be 1\u201365535')
        return
      }
      if (Number.isNaN(lPort) || lPort < 1 || lPort > 65535) {
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
          <span className="text-[11px] text-muted-foreground">
            {translate('auto.components.right.sidebar.PortsPanel.9e5a4118b0', 'Remote Port')}
          </span>
          <input
            type="text"
            inputMode="numeric"
            value={remotePort}
            onChange={(e) => {
              const val = digitsOnly(e.target.value)
              setRemotePort(val)
              const prev = Number.parseInt(remotePort, 10)
              const cur = Number.parseInt(localPort, 10)
              if (!localPort || cur === prev || cur === safeLocalPort(prev)) {
                const parsed = Number.parseInt(val, 10)
                setLocalPort(Number.isNaN(parsed) ? '' : safeLocalPort(parsed).toString())
              }
            }}
            className={INPUT_CLASS}
            placeholder="3000"
            autoFocus
            required
          />
        </label>

        <label className="block">
          <span className="text-[11px] text-muted-foreground">
            {translate('auto.components.right.sidebar.PortsPanel.b950b1948b', 'Local Port')}
          </span>
          <input
            type="text"
            inputMode="numeric"
            value={localPort}
            onChange={(e) => setLocalPort(digitsOnly(e.target.value))}
            className={INPUT_CLASS}
            placeholder={translate(
              'auto.components.right.sidebar.PortsPanel.d57545ff92',
              'Same as remote'
            )}
          />
        </label>

        <label className="block">
          <span className="text-[11px] text-muted-foreground">
            {translate('auto.components.right.sidebar.PortsPanel.a3721a50b0', 'Remote Host')}
          </span>
          <input
            type="text"
            value={remoteHost}
            onChange={(e) => setRemoteHost(e.target.value)}
            className={INPUT_CLASS}
            placeholder={translate(
              'auto.components.right.sidebar.PortsPanel.17bea6e391',
              'localhost'
            )}
          />
        </label>

        <label className="block">
          <span className="text-[11px] text-muted-foreground">
            {translate('auto.components.right.sidebar.PortsPanel.8dfed0a15c', 'Label (optional)')}
          </span>
          <input
            type="text"
            value={label}
            onChange={(e) => setLabel(e.target.value)}
            className={INPUT_CLASS}
            placeholder={translate(
              'auto.components.right.sidebar.PortsPanel.4eb801ce93',
              'dev-server'
            )}
          />
        </label>
      </div>

      {error && <div className="text-[11px] text-destructive">{error}</div>}

      <div className="flex justify-end gap-2">
        <Button type="button" variant="outline" size="sm" onClick={onClose}>
          {translate('auto.components.right.sidebar.PortsPanel.3ea4a02a8f', 'Cancel')}
        </Button>
        <Button type="submit" size="sm" disabled={submitting || !remotePort}>
          {submitting
            ? mode === 'edit'
              ? translate('auto.components.right.sidebar.PortsPanel.d7c83cfd24', 'Saving...')
              : translate('auto.components.right.sidebar.PortsPanel.9f475dc994', 'Forwarding...')
            : mode === 'edit'
              ? translate('auto.components.right.sidebar.PortsPanel.9079776663', 'Save')
              : translate('auto.components.right.sidebar.PortsPanel.c9d106547a', 'Forward')}
        </Button>
      </div>
    </form>
  )
}
