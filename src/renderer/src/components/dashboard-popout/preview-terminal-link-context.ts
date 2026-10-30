import { useAppStore } from '@/store'
import { resolveOwner } from '@/lib/resolve-owner'
import { hostRouteForAuthority } from '@/runtime/runtime-client-target'
import { findRegisteredTerminalTab } from '@/runtime/mounted-terminal-tab-registry'
import { resolveWorkspaceDirectory } from '@/lib/workspace-directory'
import { resolvePaneWslDistro } from '@/components/terminal-pane/terminal-pane-wsl-distro'
import { httpLinkActionDestinationsFor } from '@/lib/http-link-destinations'
import type { HttpLinkSourceOwner } from '@/lib/http-link-routing'
import {
  canOpenWorkspaceBrowserTabOnRuntime,
  canOpenWorkspaceBrowserTabOnSsh
} from '@/lib/workspace-browser-route-eligibility'
import { parseExecutionHostId } from '../../../../shared/execution-host'
import type { DashboardCard } from '../../../../shared/dashboard-snapshot'
import type { handleOscLink } from '@/components/terminal-pane/terminal-osc-link-routing'

export type PreviewTerminalLinkSource = Pick<
  DashboardCard,
  'worktreeId' | 'tabId' | 'executionHostId'
> &
  Partial<Pick<DashboardCard, 'leafId' | 'ptyId'>>

/** Resolve on gestures, without subscribing every dashboard preview to workspace changes. */
export function previewTerminalLinkContext(
  source?: PreviewTerminalLinkSource
): Parameters<typeof handleOscLink>[2] {
  const state = useAppStore.getState()
  const host = parseExecutionHostId(source?.executionHostId)
  const worktreePath =
    source && host ? resolveWorkspaceDirectory(state, source.worktreeId, host.id) : null
  const sourceOwner: HttpLinkSourceOwner =
    host?.kind === 'runtime'
      ? { kind: 'runtime', runtimeEnvironmentId: host.environmentId }
      : host?.kind === 'ssh'
        ? { kind: 'ssh', connectionId: host.targetId }
        : { kind: 'local' }
  const worktreeId = source?.worktreeId ?? ''
  const canOpenOwnedBrowser =
    Boolean(worktreePath) &&
    (sourceOwner.kind === 'runtime'
      ? canOpenWorkspaceBrowserTabOnRuntime(state, worktreeId, sourceOwner.runtimeEnvironmentId)
      : sourceOwner.kind === 'ssh' &&
        canOpenWorkspaceBrowserTabOnSsh(state, worktreeId, sourceOwner.connectionId))
  const owner =
    source && host ? resolveOwner(state, { workspaceId: worktreeId, hostId: host.id }) : null
  const route = owner?.kind === 'resolved' ? hostRouteForAuthority(owner.owner) : null
  const mounted = source ? findRegisteredTerminalTab(source.tabId, worktreeId)?.tab : null
  const paneId = source?.leafId ? mounted?.getManager()?.getNumericIdForLeaf(source.leafId) : null
  const paneContext =
    paneId != null && source?.ptyId && mounted?.getPtyIdForPane(paneId) === source.ptyId
      ? mounted.getLinkContextForPane?.(paneId)
      : null
  return {
    ...paneContext,
    startupCwd: paneContext?.startupCwd ?? '',
    fileContext: {
      target: route?.target ?? { kind: 'local' },
      worktreeId,
      worktreePath,
      ...(host?.kind === 'ssh' ? { connectionId: host.targetId } : {}),
      ...(route ? { expectedExecutionHostId: route.at } : {}),
      sourceHostResolved: route !== null
    },
    worktreeId,
    worktreePath: worktreePath ?? '',
    runtimeEnvironmentId: route?.target.kind === 'environment' ? route.target.environmentId : null,
    sourceTabId: worktreePath ? source?.tabId : undefined,
    wslDistro:
      worktreePath && host?.kind === 'local'
        ? resolvePaneWslDistro(state, worktreeId, worktreePath)
        : null,
    sourceOwner,
    // A pop-out has no workspace directory or browser surface; use the shared system destination.
    actionDestinations: worktreePath
      ? httpLinkActionDestinationsFor(state.settings, sourceOwner, canOpenOwnedBrowser)
      : { primary: 'system' }
  }
}
