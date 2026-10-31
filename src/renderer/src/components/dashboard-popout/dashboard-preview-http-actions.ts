import { toast } from 'sonner'
import { intentPresentation } from '@/lib/workspace-browser-tab-presentation'
import type { DashboardCard } from '../../../../shared/dashboard-snapshot'
import { parseAppSshPtyId } from '../../../../shared/ssh-pty-id'
import { parseRoutableExecutionHostId } from '../../../../shared/execution-host'
import {
  parseRemoteRuntimePtyId,
  isRemoteRuntimePtyId
} from '../../../../shared/remote-runtime/remote-runtime-pty-id'
import { useAppStore } from '@/store'
import { resolveOwner } from '@/lib/resolve-owner'
import { resolveWorktreeOperationRoute } from '@/lib/worktree-operation-route'
import { createBrowserLinkHostMatcher } from '@/lib/browser-link-owner'
import { getWorkspaceClientCreationActionPolicy } from '@/lib/client-creation-action-policy'
import {
  canOpenWorkspaceBrowserTabOnRuntime,
  canOpenWorkspaceBrowserTabOnSsh
} from '@/lib/workspace-browser-route-eligibility'
import type { HttpLinkSourceOwner } from '@/lib/http-link-routing'
import {
  buildHttpLinkActions,
  httpLinkActionDestinationsFor,
  openRoutedHttpLink,
  type HttpLinkDestination,
  type HttpLinkActionDestinations
} from '@/lib/http-link-destinations'

export type DashboardPreviewLinkSource = Pick<
  DashboardCard,
  'worktreeId' | 'executionHostId' | 'tabId'
> & { ptyId: string }

type DashboardHttpActions = ReturnType<typeof buildHttpLinkActions> & {
  owner: HttpLinkSourceOwner
  canOpen: boolean
  destinations: HttpLinkActionDestinations
  open: (destination: HttpLinkDestination | undefined, inSourceGroup?: boolean) => void
}

export function dashboardPreviewHttpActions(
  source: DashboardPreviewLinkSource,
  url: string,
  onForegroundOpen?: () => void
): DashboardHttpActions | null {
  const state = useAppStore.getState()
  const host = parseRoutableExecutionHostId(source.executionHostId)
  if (!host) {
    return null
  }
  const ssh = parseAppSshPtyId(source.ptyId)
  if (
    source.ptyId.startsWith('ssh:') &&
    (!ssh || host.kind !== 'ssh' || ssh.connectionId !== host.targetId)
  ) {
    return null
  }
  const qualified = resolveOwner(state, { workspaceId: source.worktreeId, hostId: host.id })
  const endpoint = qualified.kind === 'resolved' ? qualified.owner.endpoint : null
  const remote = parseRemoteRuntimePtyId(source.ptyId)
  if (isRemoteRuntimePtyId(source.ptyId)) {
    if (
      !remote?.environmentId ||
      endpoint?.kind !== 'environment' ||
      remote.environmentId !== endpoint.environmentId
    ) {
      return null
    }
  } else if (host.kind === 'runtime' || endpoint?.kind === 'environment') {
    return null
  }
  const owner: HttpLinkSourceOwner =
    endpoint?.kind === 'environment'
      ? { kind: 'runtime', runtimeEnvironmentId: endpoint.environmentId }
      : host.kind === 'ssh'
        ? { kind: 'ssh', connectionId: host.targetId }
        : { kind: 'local' }
  const route = resolveWorktreeOperationRoute(state, source.worktreeId)
  const matchesHost = createBrowserLinkHostMatcher(state, source.worktreeId, host.id)
  const canOpen = Boolean(
    onForegroundOpen &&
    qualified.kind === 'resolved' &&
    !(endpoint?.kind === 'environment' && qualified.owner.at !== 'local') &&
    route?.executionHostId &&
    matchesHost(route.executionHostId) &&
    getWorkspaceClientCreationActionPolicy(state, source.worktreeId)['managed-browser'].state ===
      'enabled' &&
    (owner.kind === 'local' ||
      (owner.kind === 'runtime'
        ? canOpenWorkspaceBrowserTabOnRuntime(state, source.worktreeId, owner.runtimeEnvironmentId)
        : canOpenWorkspaceBrowserTabOnSsh(state, source.worktreeId, owner.connectionId)))
  )
  const destinations = canOpen
    ? httpLinkActionDestinationsFor(state.settings, owner, true)
    : { primary: 'system' as const }
  const open = (destination: HttpLinkDestination | undefined, inSourceGroup = false): void => {
    const current = dashboardPreviewHttpActions(source, url, onForegroundOpen)
    if (!current || (destination === 'orca' && !current.canOpen)) {
      toast.error(intentPresentation({ kind: 'url' }, url).error)
      return
    }
    openRoutedHttpLink(url, {
      worktreeId: source.worktreeId,
      sourceTabId: source.tabId,
      sourceOwner: owner,
      forceDestination: destination ?? current.destinations.primary,
      ...(inSourceGroup ? { openInSourceGroup: true } : {}),
      onBrowserOpenComplete: ({ pageId, background }) => {
        if (!pageId || background || !onForegroundOpen) {
          return
        }
        const latest = useAppStore.getState()
        const group = latest.groupsByWorktree[source.worktreeId]?.find(
          (g) => g.id === latest.activeGroupIdByWorktree[source.worktreeId]
        )
        const tab = latest.unifiedTabsByWorktree[source.worktreeId]?.find(
          (t) => t.id === group?.activeTabId && t.contentType === 'browser'
        )
        const browser = latest.browserTabsByWorktree[source.worktreeId]?.find(
          (b) => b.id === tab?.entityId
        )
        if (
          latest.activeView === 'terminal' &&
          latest.activeWorktreeId === source.worktreeId &&
          matchesHost(latest.activeWorkspaceExecutionHostId) &&
          browser?.activePageId === pageId
        ) {
          onForegroundOpen()
        }
      }
    })
  }
  return {
    owner,
    canOpen,
    destinations,
    open,
    ...buildHttpLinkActions(
      destinations,
      open,
      canOpen
        ? {
            worktreeId: source.worktreeId,
            sourceTabId: source.tabId,
            sourceOwner: owner,
            url,
            openInSourceGroup: () => open('orca', true)
          }
        : undefined
    )
  }
}
