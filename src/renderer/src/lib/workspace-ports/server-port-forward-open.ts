import { toast } from 'sonner'
import { translate } from '@/i18n/i18n'
import { useAppStore } from '@/store/index'
import { selectExecutionHostDisplayLabel } from '@/runtime/hosts/display/execution-host-display-label'
import { runtimeEnvironmentSupportsCapability } from '@/runtime/rpc/compatibility/runtime-capability-proof'
import {
  toRuntimeExecutionHostId,
  toSshExecutionHostId
} from '../../../../shared/execution-host/execution-host'
import type { PortForwardEntry } from '../../../../shared/remote-runtime/ssh/ssh-types'
import { NETWORK_PORT_FORWARD_RUNTIME_CAPABILITY } from '../../../../shared/remote-runtime/protocol/workspace-ports-runtime-capabilities'
import { isLoopbackBrowserUrl } from '../../../../shared/browser/navigation/loopback-browser-url'
import type { RuntimeClientTarget } from '../../../../shared/remote-runtime/host-catalog/runtime-client-target'
import type { RestoredPortForwardMove } from '../../../../shared/remote-runtime/host-catalog/runtime-environment-port-forward-channel'
import { forwardedUrlForRemoteUrl } from './workspace-port-urls'
import { openSystemHttpLink } from '@/lib/browser/navigation/http-link-routing'
import {
  serverForwardsPorts,
  serverSshForwardTargetId,
  sshForwardsPorts,
  workspaceRunsOnServer
} from './server-port-forward-support'

type SystemOpener = (url: string) => Promise<unknown>

/** How a port's URL opens in the system browser; null when only Orca's browser on its host reaches it.
 *  `worktreeId` names the workspace a workspace port belongs to; the server's own listeners have none. */
export function portSystemBrowserOpener(
  url: string,
  target: RuntimeClientTarget,
  worktreeId: string | null
): (() => Promise<void>) | null {
  if (target.kind === 'local') {
    return () => openSystemHttpLink(url)
  }
  // A paired server's localhost reaches the system browser only through a forward of its port.
  return serverForwardsPorts(target.environmentId) &&
    isLoopbackBrowserUrl(url) &&
    (worktreeId === null || workspaceRunsOnServer(target.environmentId, worktreeId))
    ? async () => {
        await openServerLoopbackInSystemBrowser(url, target.environmentId, worktreeId)
      }
    : null
}

/**
 * Opens a paired server's localhost URL in the system browser through a forward of its port,
 * starting one first when needed. Never opens this computer's own localhost. Call only from a
 * person's gesture: it is the only way a forward starts without the Forward dialog.
 */
export async function openServerLoopbackInSystemBrowser(
  rawUrl: string,
  environmentId: string,
  /** The workspace the link or page belongs to; null for the server's own listeners. */
  worktreeId: string | null | undefined,
  /** Opens the forwarded address; resolving `false` means it did not open (superseded or refused). */
  openSystem: SystemOpener = openSystemHttpLink
): Promise<boolean> {
  const port = remoteUrlPort(rawUrl)
  if (port === null) {
    return false
  }
  const state = useAppStore.getState()
  const host = selectExecutionHostDisplayLabel(state, toRuntimeExecutionHostId(environmentId))
  // A workspace on an SSH host or WSL distro the server reaches has another localhost than the server's.
  if (worktreeId !== null && !workspaceRunsOnServer(environmentId, worktreeId)) {
    toast.error(
      translate(
        'auto.lib.workspace.ports.serverPortForward.otherMachine',
        "Couldn't forward port {{port}}: this workspace doesn't run on {{host}} itself.",
        { port, host }
      )
    )
    return false
  }
  const sshTargetId = serverSshForwardTargetId(environmentId)
  if (sshTargetId) {
    return openSshTargetLoopback(rawUrl, port, sshTargetId, host, openSystem)
  }
  const known = forwardedUrlForRemoteUrl(
    rawUrl,
    state.portForwardsByConnection[environmentId] ?? []
  )
  if (known) {
    await openSystem(known)
    return true
  }
  const api = window.api.runtimeEnvironments.portForwards
  const supported =
    api !== undefined &&
    (await runtimeEnvironmentSupportsCapability(
      environmentId,
      NETWORK_PORT_FORWARD_RUNTIME_CAPABILITY
    ).catch(() => false))
  if (!api || !supported) {
    toast.error(
      translate(
        'auto.lib.workspace.ports.serverPortForward.updateServer',
        "Couldn't forward port {{port}} from {{host}}. Update Orca on {{host}} and try again.",
        { port, host }
      )
    )
    return false
  }
  return openThroughNewForward(
    rawUrl,
    port,
    host,
    () => api.ensure({ environmentId, remotePort: port }),
    openSystem
  )
}

/** Opens an SSH host's localhost URL in the system browser through a forward of its port, starting
 *  one first when needed. Never opens this computer's own localhost. Call only from a person's gesture. */
export async function openSshLoopbackInSystemBrowser(
  rawUrl: string,
  targetId: string,
  /** Opens the forwarded address; resolving `false` means it did not open (superseded or refused). */
  openSystem: SystemOpener = openSystemHttpLink
): Promise<boolean> {
  const port = remoteUrlPort(rawUrl)
  if (port === null) {
    return false
  }
  const host = selectExecutionHostDisplayLabel(
    useAppStore.getState(),
    toSshExecutionHostId(targetId)
  )
  return openSshTargetLoopback(rawUrl, port, targetId, host, openSystem)
}

/** Resolves whether an address reached `openSystem`. */
async function openSshTargetLoopback(
  rawUrl: string,
  port: number,
  targetId: string,
  host: string,
  openSystem: SystemOpener
): Promise<boolean> {
  const known = forwardedUrlForRemoteUrl(
    rawUrl,
    useAppStore.getState().portForwardsByConnection[targetId] ?? []
  )
  if (known) {
    await openSystem(known)
    return true
  }
  const ensure = window.api.ssh?.ensurePortForward
  if (!ensure || !sshForwardsPorts(targetId)) {
    toast.error(
      translate(
        'auto.lib.workspace.ports.serverPortForward.useSshPorts',
        "Couldn't forward port {{port}} from {{host}}. Forward it in Ports, then try again.",
        { port, host }
      )
    )
    return false
  }
  return openThroughNewForward(
    rawUrl,
    port,
    host,
    () => ensure({ targetId, remotePort: port }),
    openSystem
  )
}

function remoteUrlPort(rawUrl: string): number | null {
  try {
    const url = new URL(rawUrl)
    return Number(url.port) || (url.protocol === 'https:' ? 443 : 80)
  } catch {
    return null
  }
}

async function openThroughNewForward(
  rawUrl: string,
  port: number,
  host: string,
  ensure: () => Promise<{ entry: PortForwardEntry; created: boolean }>,
  openSystem: SystemOpener
): Promise<boolean> {
  let target: string | null
  let created: boolean
  try {
    const result = await ensure()
    target = forwardedUrlForRemoteUrl(rawUrl, [result.entry])
    created = result.created
  } catch {
    target = null
    created = false
  }
  if (!target) {
    toast.error(
      translate(
        'auto.lib.workspace.ports.serverPortForward.failed',
        "Couldn't forward port {{port}} from {{host}}. Check the connection and try again.",
        { port, host }
      )
    )
    return false
  }
  const opened = (await openSystem(target)) !== false
  if (created) {
    toast.success(
      translate(
        'auto.lib.workspace.ports.serverPortForward.forwarded',
        'Forwarded port {{port}} from {{host}}',
        { port, host }
      ),
      // Say the page opened only when it did.
      opened
        ? {
            description: translate(
              'auto.lib.workspace.ports.serverPortForward.opened',
              'Opened {{address}} in your default browser.',
              { address: new URL(target).host }
            )
          }
        : undefined
    )
  }
  return true
}

/** Tells the person once that a forward restored after a restart listens on another port here. */
export async function announceRestoredPortForwardMoves(
  moves: readonly RestoredPortForwardMove[]
): Promise<void> {
  if (moves.length === 0) {
    return
  }
  // A restore can land before this window has loaded its server list; main's list has the names.
  const known = new Set(useAppStore.getState().runtimeEnvironments?.map((env) => env.id))
  const savedNames = moves.every((move) => known.has(move.environmentId))
    ? new Map<string, string>()
    : new Map(
        (await window.api.runtimeEnvironments.list().catch(() => [])).map(
          (env): [string, string] => [env.id, env.name]
        )
      )
  for (const move of moves) {
    const host =
      savedNames.get(move.environmentId) ??
      selectExecutionHostDisplayLabel(
        useAppStore.getState(),
        toRuntimeExecutionHostId(move.environmentId)
      )
    toast.info(
      translate(
        'auto.lib.workspace.ports.serverPortForward.restoredMoved',
        'Forwarded port {{port}} from {{host}} to localhost:{{localPort}}',
        { port: move.remotePort, host, localPort: move.localPort }
      ),
      {
        description: translate(
          'auto.lib.workspace.ports.serverPortForward.restoredMovedReason',
          'localhost:{{previousPort}} is in use on this computer.',
          { previousPort: move.previousLocalPort }
        )
      }
    )
  }
}
