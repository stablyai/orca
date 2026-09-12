import React, { useCallback, useMemo, useState } from 'react'
import { ChevronRight, Plus, Unplug } from 'lucide-react'
import { toast } from 'sonner'
import { useAppStore } from '@/store'
import { useActiveWorktree, useRepoById } from '@/store/selectors'
import { cn } from '@/lib/utils'
import { resolvePortOpenInOrcaBrowser } from '@/lib/workspace-port-actions'
import { browserUrlForPortForwardEntry } from '@/lib/workspace-port-urls'
import type { EnrichedDetectedPort, PortForwardEntry } from '../../../../shared/ssh-types'
import { translate } from '@/i18n/i18n'
import { openWorkspaceBrowserTab } from '@/lib/workspace-browser-tab-open'
import { SshForwardedPortRow } from './ssh-forwarded-port-row'
import { SshDetectedPortRow } from './ssh-detected-port-row'
import { SshPortForwardDialog, type PortForwardDialogState } from './ssh-port-forward-dialog'

// Why: forwarded SSH ports and detected remote ports may report the same loopback
// endpoint using different textual hosts. Normalize for deduping only.
const LOOPBACK_HOSTS = new Set(['localhost', '127.0.0.1', '::1', '0.0.0.0', '::'])
function normalizeHost(host: string | undefined): string {
  if (!host || LOOPBACK_HOSTS.has(host)) {
    return 'localhost'
  }
  return host
}

export function SshPortsPanel(): React.JSX.Element {
  const settings = useAppStore((s) => s.settings)
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

  const handleForwardDetected = useCallback((port: EnrichedDetectedPort & { targetId: string }) => {
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

  const handleOpenForwardInBrowser = useCallback(
    (entry: PortForwardEntry, event?: React.MouseEvent<HTMLButtonElement>) => {
      const url = browserUrlForPortForwardEntry(entry)
      if (
        !resolvePortOpenInOrcaBrowser({
          settings,
          event,
          isMac: navigator.userAgent.includes('Mac')
        })
      ) {
        void window.api.shell.openUrl(url)
        return
      }
      if (!activeWorktree?.id) {
        toast.error(
          translate(
            'auto.components.right.sidebar.PortsPanel.409afcc145',
            'No workspace selected for the browser.'
          )
        )
        return
      }
      void openWorkspaceBrowserTab({
        workspaceId: activeWorktree.id,
        url,
        intent: { kind: 'url' }
      }).catch((error) => {
        toast.error(error instanceof Error ? error.message : String(error))
      })
    },
    [activeWorktree?.id, settings]
  )

  const handleDialogClose = useCallback(() => {
    setDialogState({ mode: 'closed' })
  }, [])

  if (isDisconnected) {
    return (
      <div className="flex flex-col items-center justify-center h-full px-4 text-center text-muted-foreground">
        <Unplug size={32} className="mb-3 opacity-50" />
        <p className="text-sm font-medium">
          {translate('auto.components.right.sidebar.PortsPanel.a2f1a47f42', 'SSH connection lost')}
        </p>
        <p className="text-xs mt-1">
          {translate('auto.components.right.sidebar.PortsPanel.d4c3cd679c', 'Reconnecting...')}
        </p>
      </div>
    )
  }

  return (
    <div className="flex flex-col h-full overflow-y-auto scrollbar-sleek">
      {/* Header */}
      <div className="flex items-center justify-between px-3 py-2 border-b border-border">
        <span className="text-[11px] font-semibold uppercase tracking-wider text-muted-foreground">
          {translate('auto.components.right.sidebar.PortsPanel.6bc058dbe1', 'Ports')}
        </span>
        <button
          type="button"
          className="flex items-center gap-1 text-xs text-muted-foreground hover:text-foreground transition-colors"
          onClick={() =>
            setDialogState({ mode: 'add', defaults: { targetId: activeConnectionId ?? undefined } })
          }
        >
          <Plus size={14} />
          {translate('auto.components.right.sidebar.PortsPanel.a103dae837', 'Add')}
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
              {translate('auto.components.right.sidebar.PortsPanel.ddbe58d74e', 'Forwarded')}
            </span>
            <span className="text-[10px] text-muted-foreground/60 ml-1">{allForwards.length}</span>
          </button>
          {!forwardedCollapsed &&
            allForwards.map((entry) => (
              <SshForwardedPortRow
                key={entry.id}
                entry={entry}
                onEdit={() => handleEdit(entry)}
                onOpenInBrowser={(event) => handleOpenForwardInBrowser(entry, event)}
              />
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
              {translate('auto.components.right.sidebar.PortsPanel.36b1b2984a', 'Detected')}
            </span>
            <span className="text-[10px] text-muted-foreground/60 ml-1">{allDetected.length}</span>
          </button>
          {!detectedCollapsed &&
            allDetected.map((port) => (
              <SshDetectedPortRow
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
          <p className="text-sm">
            {translate('auto.components.right.sidebar.PortsPanel.1f0d2a24f9', 'No forwarded ports')}
          </p>
          <p className="text-xs mt-1 mb-3">
            {translate(
              'auto.components.right.sidebar.PortsPanel.04efd3dad4',
              'Forward a port to access remote services on your local machine.'
            )}
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
            {translate('auto.components.right.sidebar.PortsPanel.907eb53ed2', 'Forward a Port')}
          </button>
        </div>
      )}

      <SshPortForwardDialog
        state={dialogState}
        activeConnectionId={activeConnectionId}
        onClose={handleDialogClose}
      />
    </div>
  )
}
