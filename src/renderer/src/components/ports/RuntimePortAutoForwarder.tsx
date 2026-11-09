import { useEffect, useMemo, useRef } from 'react'
import { toast } from 'sonner'
import { useAppStore } from '@/store'
import { translate } from '@/i18n/i18n'
import { openAppHttpLink } from '@/lib/browser/navigation/app-http-link-open'
import { installWindowVisibilityInterval } from '@/lib/window-visibility-interval'
import {
  publishWorkspacePortScanForHost,
  scanWorkspacePortsForTarget,
  workspacePortScanKeyForTarget
} from '@/lib/workspace-ports/workspace-port-actions'
import { runtimeRpcTargetForAuthorityKey } from '@/runtime/rpc/targets/runtime-client-target'
import {
  closeRuntimePortForward,
  getRuntimePortForwards,
  isRuntimePortForwardUserClosed,
  openRuntimePortForward,
  runtimePortForwardingAvailable,
  runtimePortForwardUrl
} from '@/lib/runtime-port-forwards/runtime-port-forwards-store'
import { planAutoForwards } from '@/lib/runtime-port-forwards/runtime-port-auto-forward-plan'
import { buildExecutionHostRegistry } from '../../../../shared/execution-host/execution-host-registry'
import type { RuntimeClientTarget } from '../../../../shared/runtime-client-target'
import type { WorkspacePort, WorkspacePortScanResult } from '../../../../shared/workspace-ports'
import {
  normalizeRuntimePortForwardSettings,
  type RuntimePortForward,
  type RuntimePortForwardSettings
} from '../../../../shared/runtime-port-forwards'

// Remote hosts get a quicker scan than the shared 30s one so a new dev server is forwarded within seconds.
const REMOTE_PORT_SCAN_INTERVAL_MS = 4_000

type HostState = {
  attempted: Set<number>
  missing: Map<number, number>
  /** The first scan (and the first after a settings change) forwards silently: those servers were already running. */
  scanned: boolean
  settingsKey: string
  /** The host cannot forward (older Orca); stop asking until the app restarts. */
  unsupported: boolean
  inFlight: boolean
}

function settingsKey(settings: RuntimePortForwardSettings): string {
  return `${settings.autoForward}:${settings.rangeStart}:${settings.rangeEnd}`
}

function scanSignature(scan: WorkspacePortScanResult): string {
  return [
    scan.unavailableReason ?? '',
    ...scan.ports
      .map((port) =>
        [
          port.port,
          port.bindHost,
          port.pid ?? '',
          port.kind,
          port.processName ?? '',
          port.kind === 'workspace' ? `${port.owner.worktreeId}:${port.advertisedUrl ?? ''}` : ''
        ].join('|')
      )
      .sort()
  ].join('\n')
}

function environmentTargets(
  repos: Parameters<typeof buildExecutionHostRegistry>[0]['repos'],
  settings: Parameters<typeof buildExecutionHostRegistry>[0]['settings']
): Extract<RuntimeClientTarget, { kind: 'environment' }>[] {
  return buildExecutionHostRegistry({ repos, settings })
    .map((host) => runtimeRpcTargetForAuthorityKey(host.id))
    .filter(
      (target): target is Extract<RuntimeClientTarget, { kind: 'environment' }> =>
        target?.kind === 'environment'
    )
}

function announce(port: WorkspacePort, forward: RuntimePortForward): void {
  const url = runtimePortForwardUrl(forward, port.protocol === 'https' ? 'https' : 'http')
  const source = [port.processName, port.kind === 'workspace' ? port.owner.displayName : null]
    .filter(Boolean)
    .join(' · ')
  toast.success(
    translate(
      'auto.components.ports.RuntimePortAutoForwarder.ready',
      'localhost:{{value0}} is ready',
      {
        value0: forward.localPort
      }
    ),
    {
      id: `runtime-port-forward:${forward.environmentId}:${forward.remotePort}`,
      description:
        forward.localPort === port.port
          ? source
          : translate(
              'auto.components.ports.RuntimePortAutoForwarder.remapped',
              '{{value0}} · :{{value1}} was taken here',
              { value0: source, value1: port.port }
            ),
      action: {
        label: translate('auto.components.ports.RuntimePortAutoForwarder.open', 'Open'),
        onClick: () =>
          openAppHttpLink(url, {
            worktreeId: port.kind === 'workspace' ? port.owner.worktreeId : null
          })
      }
    }
  )
}

function announceBusy(port: WorkspacePort, environmentId: string): void {
  toast.warning(
    translate(
      'auto.components.ports.RuntimePortAutoForwarder.busy',
      'localhost:{{value0}} is in use here',
      { value0: port.port }
    ),
    {
      id: `runtime-port-forward:${environmentId}:${port.port}`,
      description: translate(
        'auto.components.ports.RuntimePortAutoForwarder.busyDescription',
        '"Same port number only" is on, so :{{value0}} was not forwarded.',
        { value0: port.port }
      ),
      action: {
        label: translate(
          'auto.components.ports.RuntimePortAutoForwarder.useAnother',
          'Use another port'
        ),
        onClick: () =>
          void openRuntimePortForward({
            environmentId,
            remotePort: port.port,
            reason: 'user'
          }).then((result) => {
            if (result.ok) {
              openAppHttpLink(runtimePortForwardUrl(result.forward), {
                worktreeId: port.kind === 'workspace' ? port.owner.worktreeId : null
              })
            }
          })
      }
    }
  )
}

// Mounted once in AppBackgroundServices; the app has a single main window.
/** Forwards dev servers that start on remote hosts to this computer's localhost and announces them. */
export function RuntimePortAutoForwarder({ enabled }: { enabled: boolean }): null {
  const repos = useAppStore((s) => s.repos)
  const appSettings = useAppStore((s) => s.settings)
  const forwardSettings = useMemo(
    () => normalizeRuntimePortForwardSettings(appSettings?.runtimePortForwarding),
    [appSettings?.runtimePortForwarding]
  )
  const targets = useMemo(() => environmentTargets(repos, appSettings), [repos, appSettings])
  const targetsSignature = targets.map((target) => target.environmentId).join('\n')
  const settingsRef = useRef<RuntimePortForwardSettings>(forwardSettings)
  const targetsRef = useRef(targets)
  useEffect(() => {
    settingsRef.current = forwardSettings
    targetsRef.current = targets
  }, [forwardSettings, targets])
  const hostStates = useRef(new Map<string, HostState>())

  useEffect(() => {
    if (!enabled || !runtimePortForwardingAvailable() || targetsSignature === '') {
      return
    }
    let disposed = false
    const stateFor = (environmentId: string): HostState => {
      let state = hostStates.current.get(environmentId)
      if (!state) {
        state = {
          attempted: new Set(),
          missing: new Map(),
          scanned: false,
          settingsKey: '',
          unsupported: false,
          inFlight: false
        }
        hostStates.current.set(environmentId, state)
      }
      return state
    }
    const reconcileHost = async (
      target: Extract<RuntimeClientTarget, { kind: 'environment' }>,
      state: HostState
    ): Promise<void> => {
      const scan = await scanWorkspacePortsForTarget(target).catch(() => null)
      if (disposed || !scan || scan.unavailableReason) {
        return
      }
      const store = useAppStore.getState()
      const scanKey = workspacePortScanKeyForTarget(target)
      const published = store.workspacePortScansByKey[scanKey]
      // Republishing an identical scan would re-render every port surface each tick.
      if (!published || scanSignature(scan) !== scanSignature(published)) {
        publishWorkspacePortScanForHost({
          scanKey,
          scan,
          replaceWorkspacePortScans: store.replaceWorkspacePortScans,
          getWorkspacePortScansByKey: () => useAppStore.getState().workspacePortScansByKey
        })
      }
      const settings = settingsRef.current
      const key = settingsKey(settings)
      if (state.settingsKey !== key) {
        state.settingsKey = key
        state.scanned = false
      }
      const firstScan = !state.scanned
      state.scanned = true
      const forwards = getRuntimePortForwards().filter(
        (forward) => forward.environmentId === target.environmentId
      )
      // Anything already forwarded (by the user, SSH, another window) counts as handled.
      for (const forward of forwards) {
        state.attempted.add(forward.remotePort)
      }
      const plan = planAutoForwards({
        ports: scan.ports.filter(
          (port) => !isRuntimePortForwardUserClosed(target.environmentId, port.port)
        ),
        forwards,
        settings,
        attempted: state.attempted,
        previousMissing: state.missing
      })
      state.missing = plan.missing
      for (const forward of plan.close) {
        state.attempted.delete(forward.remotePort)
        await closeRuntimePortForward(forward, false)
      }
      // A stopped server may come back; let it be forwarded again then.
      const listening = new Set(scan.ports.map((port) => port.port))
      for (const port of state.attempted) {
        if (!listening.has(port) && !forwards.some((forward) => forward.remotePort === port)) {
          state.attempted.delete(port)
        }
      }
      if (state.unsupported) {
        return
      }
      for (const port of plan.open) {
        state.attempted.add(port.port)
        const result = await openRuntimePortForward({
          environmentId: target.environmentId,
          remotePort: port.port,
          reason: 'auto',
          exclusive: settings.exclusive,
          label: port.processName
        })
        if (disposed) {
          return
        }
        if (result.ok) {
          if (settings.notify && !firstScan) {
            announce(port, result.forward)
          }
        } else if (result.code === 'port_busy' && settings.notify && !firstScan) {
          announceBusy(port, target.environmentId)
        } else if (result.code === 'host_unsupported') {
          state.unsupported = true
          return
        }
      }
    }
    const run = (): void => {
      const settings = settingsRef.current
      for (const target of targetsRef.current) {
        const state = stateFor(target.environmentId)
        const hasAutoForwards = getRuntimePortForwards().some(
          (forward) => forward.environmentId === target.environmentId && forward.reason === 'auto'
        )
        // With auto-forward off and nothing to retire, the shared 30s scan is enough.
        if (state.inFlight || (!settings.autoForward && !hasAutoForwards)) {
          continue
        }
        // Per host, so a sleeping VM's slow scan does not hold up the others.
        state.inFlight = true
        void reconcileHost(target, state).finally(() => {
          state.inFlight = false
        })
      }
    }
    run()
    const stop = installWindowVisibilityInterval({
      run,
      slowWhileUnfocused: true,
      intervalMs: REMOTE_PORT_SCAN_INTERVAL_MS
    })
    return () => {
      disposed = true
      stop()
    }
  }, [enabled, targetsSignature])

  return null
}
