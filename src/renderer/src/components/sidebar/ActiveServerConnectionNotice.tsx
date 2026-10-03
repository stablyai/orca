import { useRef, useState } from 'react'
import { Loader2, Server, ServerOff } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { useAppStore } from '@/store'
import { useMountedRef } from '@/hooks/useMountedRef'
import { translate } from '@/i18n/i18n'
import { cn } from '@/lib/utils'
import { isPairedWebClientWindow } from '@/lib/desktop-window-chrome'
import { getHostDisplayLabelOverrides } from '../../../../shared/host-setting-overrides'
import { toRuntimeExecutionHostId } from '../../../../shared/execution-host'
import { isUserManagedRuntimeEnvironment } from '../../../../shared/runtime-environments'
import { runtimeHostConnectionStateForEntry } from '@/runtime/runtime-host-connection-state'
import { runtimeStatusLabel, runtimeStatusTone } from '../status-bar/RuntimeHostStatusRow'
import {
  connectRuntimeEnvironmentAndRecordStatus,
  connectRuntimeHostForNavigation
} from '../status-bar/runtime-environment-explicit-connect'

export function ActiveServerConnectionNotice(): React.JSX.Element | null {
  const settings = useAppStore((state) => state.settings)
  const environments = useAppStore((state) => state.runtimeEnvironments)
  const entry = useAppStore((state) =>
    state.runtimeStatusByEnvironmentId?.get(state.settings?.activeRuntimeEnvironmentId ?? '')
  )
  const [pending, setPending] = useState(false)
  const [failedId, setFailedId] = useState<string | null>(null)
  const pendingRef = useRef(false)
  const mountedRef = useMountedRef()
  const environment = environments?.find(
    (host) =>
      host.id === settings?.activeRuntimeEnvironmentId && isUserManagedRuntimeEnvironment(host)
  )
  const state = runtimeHostConnectionStateForEntry(entry)

  if (
    !environment ||
    isPairedWebClientWindow() ||
    (state !== 'disconnected' && state !== 'reconnecting' && state !== 'runtime-unavailable')
  ) {
    return null
  }
  const label =
    getHostDisplayLabelOverrides(settings).get(toRuntimeExecutionHostId(environment.id)) ??
    environment.name
  const reconnect = async (): Promise<void> => {
    if (pendingRef.current) {
      return
    }
    pendingRef.current = true
    setPending(true)
    setFailedId(null)
    try {
      const store = useAppStore.getState()
      const connected = await connectRuntimeHostForNavigation({
        environmentId: environment.id,
        refreshStatus: connectRuntimeEnvironmentAndRecordStatus,
        fetchRepos: store.fetchRuntimeEnvironmentRepos,
        fetchWorktrees: store.fetchWorktrees,
        fetchLineage: store.fetchWorktreeLineage
      })
      if (!connected && mountedRef.current) {
        setFailedId(environment.id)
      }
    } catch {
      if (mountedRef.current) {
        setFailedId(environment.id)
      }
    } finally {
      pendingRef.current = false
      if (mountedRef.current) {
        setPending(false)
      }
    }
  }

  const StatusIcon =
    state === 'reconnecting' ? Loader2 : state === 'disconnected' ? ServerOff : Server

  return (
    <section
      role="status"
      aria-label={label}
      aria-live="polite"
      aria-busy={pending}
      className={cn(
        'mx-2 mb-2 shrink-0 rounded-md border bg-worktree-sidebar-accent/40 p-2.5 text-worktree-sidebar-foreground',
        state === 'disconnected' ? 'border-destructive/50' : 'border-border'
      )}
    >
      <div className="flex items-start gap-2">
        <StatusIcon
          className={cn(
            'mt-px size-3.5 shrink-0',
            state === 'reconnecting' ? 'text-muted-foreground' : runtimeStatusTone(state),
            state === 'reconnecting' && 'animate-spin'
          )}
          aria-hidden="true"
        />
        <div className="min-w-0 flex-1 space-y-1.5">
          <p className="break-words text-xs font-semibold leading-snug">
            {label} · {runtimeStatusLabel(state)}
          </p>
          <p className="text-xs leading-snug text-muted-foreground">
            {failedId === environment.id
              ? translate(
                  'auto.components.status.bar.SshStatusSegment.runtime_connect_unavailable',
                  'Remote host is not reachable'
                )
              : translate(
                  'auto.components.sidebar.ActiveServerConnectionNotice.body',
                  'Connect to open or create workspaces on this server.'
                )}
          </p>
          <Button
            type="button"
            variant="outline"
            size="xs"
            disabled={pending}
            onClick={() => void reconnect()}
          >
            {pending ? <Loader2 className="animate-spin" aria-hidden="true" /> : null}
            {translate(
              'auto.components.terminal.pane.TerminalRemoteRuntimeReconnectBanner.reconnectButton',
              'Reconnect'
            )}
          </Button>
        </div>
      </div>
    </section>
  )
}
