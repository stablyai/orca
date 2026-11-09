import { useCallback, useMemo, type ReactNode } from 'react'
import { BellOff, Copy, Plug, Unplug } from 'lucide-react'
import { toast } from 'sonner'
import { ContextMenuItem } from '@/components/ui/context-menu'
import { useAppStore } from '@/store'
import { useTranslate } from '@/i18n/use-translate'
import { openAppHttpLink } from '@/lib/browser/navigation/app-http-link-open'
import {
  closeRuntimePortForward,
  openRuntimePortForward,
  portForwardKey,
  runtimePortForwardFailureText,
  runtimePortForwardingAvailable,
  runtimePortForwardUrl,
  useRuntimePortForwardState,
  wakeRuntimePortForwardHost
} from '@/lib/runtime-port-forwards/runtime-port-forwards-store'
import type { RuntimeClientTarget } from '../../../../shared/runtime-client-target'
import type { RuntimePortForward } from '../../../../shared/runtime-port-forwards'
import type { WorkspacePort } from '../../../../shared/workspace-ports'
import type { PortRowForwarding } from './local-port-section'
import {
  RuntimePortForwardStatus,
  RuntimePortForwardStopButton,
  type RuntimePortForwardRowState
} from './runtime-port-forward-status'

const MENU_ITEM_CLASS =
  'rounded-md focus:bg-accent focus:text-accent-foreground dark:focus:bg-accent'

function localUrl(forward: RuntimePortForward, port: WorkspacePort): string {
  const base = runtimePortForwardUrl(forward, port.protocol === 'https' ? 'https' : 'http')
  if (port.kind !== 'workspace' || !port.advertisedUrl) {
    return base
  }
  try {
    // Keep the path a dev server printed (e.g. /docs) on the forwarded origin.
    const advertised = new URL(port.advertisedUrl)
    return `${base}${advertised.pathname === '/' ? '' : advertised.pathname}`
  } catch {
    return base
  }
}

export type RuntimePortRowForwarding = {
  forwarding: PortRowForwarding
  /** Forwards (if needed) and opens the port in the system browser through this computer's localhost. */
  openLocally: (port: WorkspacePort) => Promise<void>
  forwards: RuntimePortForward[]
  /** Latest forward outcome for one always-mounted polite live region. */
  announcement: string
}

/** Row forwarding UI for a remote environment's ports; null when the target is this computer. */
export function useRuntimePortRowForwarding(
  runtimeTarget: RuntimeClientTarget | null,
  /** Host actions after the forward items (Orca Cloud: Share…). */
  extraMenuItems?: (port: WorkspacePort) => ReactNode,
  /** Orca Cloud: copy says "sandbox", and offline offers Wake. */
  isSandbox = false
): RuntimePortRowForwarding | null {
  const t = useTranslate()
  const environmentId = runtimeTarget?.kind === 'environment' ? runtimeTarget.environmentId : null
  const { forwards: allForwards, pending, failures, announcement } = useRuntimePortForwardState()
  // A known host whose connection is down: forwards stay bound but nothing reaches it until it returns.
  const hostOffline = useAppStore((s) => {
    const entry = environmentId ? s.runtimeStatusByEnvironmentId.get(environmentId) : undefined
    return entry ? entry.status === null : false
  })
  const forwards = useMemo(
    () => allForwards.filter((forward) => forward.environmentId === environmentId),
    [allForwards, environmentId]
  )

  const forwardFor = useCallback(
    (port: WorkspacePort) => forwards.find((forward) => forward.remotePort === port.port),
    [forwards]
  )

  const forward = useCallback(
    async (port: WorkspacePort): Promise<RuntimePortForward | null> => {
      if (!environmentId) {
        return null
      }
      const result = await openRuntimePortForward({
        environmentId,
        remotePort: port.port,
        reason: 'user',
        label: port.processName
      })
      return result.ok ? result.forward : null
    },
    [environmentId]
  )

  const openLocally = useCallback(
    async (port: WorkspacePort) => {
      const existing = forwardFor(port) ?? (await forward(port))
      if (existing) {
        // Explicit system-browser open (Shift+Cmd/Ctrl or the setting): the forward makes it reachable here.
        await window.api.shell.openUrl(localUrl(existing, port))
      }
    },
    [forward, forwardFor]
  )

  const forwarding = useMemo<PortRowForwarding>(() => {
    const rowState = (port: WorkspacePort): RuntimePortForwardRowState => {
      const existing = forwardFor(port)
      const key = portForwardKey(environmentId ?? '', port.port)
      const failure = failures.get(key)
      return existing
        ? { kind: 'forwarded', forward: existing, hostOffline }
        : pending.has(key)
          ? { kind: 'pending' }
          : failure
            ? {
                kind: 'failed',
                message: runtimePortForwardFailureText(failure),
                busy: failure.code === 'port_busy'
              }
            : { kind: 'unforwarded' }
    }
    return {
      status: (port) => (
        <RuntimePortForwardStatus
          remotePort={port.port}
          state={rowState(port)}
          isSandbox={isSandbox}
          onForward={() => void forward(port)}
          onReconnect={
            environmentId ? () => void wakeRuntimePortForwardHost(environmentId) : undefined
          }
          onOpenLocal={(target) =>
            openAppHttpLink(localUrl(target, port), {
              worktreeId: port.kind === 'workspace' ? port.owner.worktreeId : null
            })
          }
        />
      ),
      actions: (port) => {
        const existing = forwardFor(port)
        return existing ? (
          <RuntimePortForwardStopButton
            remotePort={port.port}
            onStop={() => void closeRuntimePortForward(existing)}
          />
        ) : null
      },
      menuItems: (port) => {
        const existing = forwardFor(port)
        const forwardItems = existing ? (
          <>
            <ContextMenuItem
              className={MENU_ITEM_CLASS}
              onSelect={() => {
                void window.api.ui.writeClipboardText(localUrl(existing, port))
                toast.success(
                  t(
                    'auto.components.right.sidebar.RuntimePortForward.copied',
                    'Copied {{value0}}',
                    { value0: `localhost:${existing.localPort}` }
                  )
                )
              }}
            >
              <Copy size={13} />
              {t('auto.components.right.sidebar.RuntimePortForward.copyLocalUrl', 'Copy local URL')}
            </ContextMenuItem>
            <ContextMenuItem
              className={MENU_ITEM_CLASS}
              onSelect={() => void closeRuntimePortForward(existing)}
            >
              {existing.reason === 'auto' ? <BellOff size={13} /> : <Unplug size={13} />}
              {existing.reason === 'auto'
                ? t(
                    'auto.components.right.sidebar.RuntimePortForward.stopAndSkip',
                    "Stop and don't auto-forward :{{value0}}",
                    { value0: port.port }
                  )
                : t(
                    'auto.components.right.sidebar.RuntimePortForward.stopForwarding',
                    'Stop forwarding'
                  )}
            </ContextMenuItem>
          </>
        ) : (
          <ContextMenuItem className={MENU_ITEM_CLASS} onSelect={() => void forward(port)}>
            <Plug size={13} />
            {t('auto.components.right.sidebar.RuntimePortForward.forward', 'Forward to localhost')}
          </ContextMenuItem>
        )
        return (
          <>
            {forwardItems}
            {extraMenuItems?.(port)}
          </>
        )
      },
      copyAddress: (port) => {
        const existing = forwardFor(port)
        return existing ? `localhost:${existing.localPort}` : undefined
      }
    }
  }, [
    environmentId,
    extraMenuItems,
    failures,
    forward,
    forwardFor,
    hostOffline,
    isSandbox,
    pending,
    t
  ])

  if (!environmentId || !runtimePortForwardingAvailable()) {
    return null
  }
  return { forwarding, openLocally, forwards, announcement }
}
