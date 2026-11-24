import { toast } from 'sonner'
import { translate } from '@/i18n/i18n'
import { useAppStore } from '@/store/index'
import { selectExecutionHostDisplayLabel } from '@/runtime/hosts/display/execution-host-display-label'
import { runtimeEnvironmentSupportsCapability } from '@/runtime/rpc/compatibility/runtime-capability-proof'
import { toRuntimeExecutionHostId } from '../../../../shared/execution-host/execution-host'
import { NETWORK_PORT_FORWARD_RUNTIME_CAPABILITY } from '../../../../shared/remote-runtime/protocol/workspace-ports-runtime-capabilities'
import { isLoopbackBrowserUrl } from '../../../../shared/browser/navigation/loopback-browser-url'
import type { RuntimeClientTarget } from '../../../../shared/remote-runtime/host-catalog/runtime-client-target'
import { forwardedUrlForRemoteUrl } from './workspace-port-urls'
import { openSystemHttpLink } from '@/lib/browser/navigation/http-link-routing'
import {
  serverForwardsPorts,
  serverSshForwardTargetId,
  workspaceRunsOnServer
} from './server-port-forward-support'

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
    ? () => openServerLoopbackInSystemBrowser(url, target.environmentId, worktreeId)
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
  /** Opens the forwarded address; a link chooser passes one that reports the shell's answer. */
  openSystem: (url: string) => Promise<unknown> = openSystemHttpLink
): Promise<boolean> {
  let url: URL
  try {
    url = new URL(rawUrl)
  } catch {
    return false
  }
  const port = Number(url.port) || (url.protocol === 'https:' ? 443 : 80)
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
  const known = forwardedUrlForRemoteUrl(
    rawUrl,
    state.portForwardsByConnection[sshTargetId ?? environmentId] ?? []
  )
  if (known) {
    await openSystem(known)
    return true
  }
  if (sshTargetId) {
    toast.error(
      translate(
        'auto.lib.workspace.ports.serverPortForward.useSshPorts',
        "Couldn't forward port {{port}} from {{host}}. Forward it in Ports, then try again.",
        { port, host }
      )
    )
    return false
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
  let target: string | null
  let created: boolean
  try {
    const result = await api.ensure({ environmentId, remotePort: port })
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
  await openSystem(target)
  if (created) {
    toast.success(
      translate(
        'auto.lib.workspace.ports.serverPortForward.forwarded',
        'Forwarded port {{port}} from {{host}}',
        { port, host }
      ),
      {
        description: translate(
          'auto.lib.workspace.ports.serverPortForward.opened',
          'Opened {{address}} in your default browser.',
          { address: new URL(target).host }
        )
      }
    )
  }
  return true
}
