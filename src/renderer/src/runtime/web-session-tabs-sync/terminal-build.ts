import type { RuntimeMobileSessionTabsResult } from '../../../../shared/runtime-types'
import type { TerminalLayoutSnapshot, TerminalTab } from '../../../../shared/terminal-tab-types'
import { normalizeTerminalLayoutPtyOwnership } from '@/components/terminal-pane/terminal-layout-pty-ownership'
import { resolvePaneAgentOwnerRecord } from '../../../../shared/pane-agent-owner'
import { normalizeCompatibleAgentTitleForOwner } from '../../../../shared/agent-title-owner'
import { getRemoteRuntimePtyEnvironmentId, toRemoteRuntimePtyId } from '../runtime-terminal-stream'
import { toWebTerminalSurfaceTabId } from '../web-runtime-session'
import type { MirroredTerminalTab, TerminalSurface, ReadyTerminalSurface } from './state'
import { chooseRemoteTerminalLayout, isTerminalSurfaceTab } from './terminal-surfaces'

function pendingBindingBelongsToEnvironment(
  ptyId: string,
  environmentId: string,
  terminalPtyMode: 'local' | 'remote'
): boolean {
  const ownerEnvironmentId = getRemoteRuntimePtyEnvironmentId(ptyId)
  return terminalPtyMode === 'local'
    ? ownerEnvironmentId === null
    : ownerEnvironmentId === environmentId
}

/** Keep a known pane binding while the host briefly publishes its surface as pending. */
function retainPendingTerminalBindings(
  surfaces: readonly TerminalSurface[],
  existingLayout: TerminalLayoutSnapshot | undefined,
  ptyIdsByLeafId: Record<string, string>,
  environmentId: string,
  terminalPtyMode: 'local' | 'remote'
): Record<string, string> {
  const existingBindings = existingLayout?.ptyIdsByLeafId
  if (!existingBindings) {
    return ptyIdsByLeafId
  }
  let retained = ptyIdsByLeafId
  for (const surface of surfaces) {
    if (surface.status !== 'pending-handle' || Object.hasOwn(retained, surface.leafId)) {
      continue
    }
    const priorPtyId = existingBindings[surface.leafId]
    if (
      !priorPtyId ||
      !pendingBindingBelongsToEnvironment(priorPtyId, environmentId, terminalPtyMode)
    ) {
      continue
    }
    if (retained === ptyIdsByLeafId) {
      retained = { ...ptyIdsByLeafId }
    }
    retained[surface.leafId] = priorPtyId
  }
  return retained
}

/** Constructs mirrored terminal tabs from the mobile session status payload, normalising Pi-compatible agent titles under launch ownership. */
export function buildMirroredTerminalTabs(
  snapshot: RuntimeMobileSessionTabsResult,
  environmentId: string,
  existingById: ReadonlyMap<string, TerminalTab>,
  existingLayoutsByTabId: Readonly<Record<string, TerminalLayoutSnapshot>>,
  sortOffset: number,
  now: number,
  focusTarget?: { parentTabId: string; leafId: string },
  terminalPtyMode: 'local' | 'remote' = 'remote'
): MirroredTerminalTab[] {
  const groups = new Map<string, TerminalSurface[]>()
  for (const tab of snapshot.tabs.filter(isTerminalSurfaceTab)) {
    const group = groups.get(tab.parentTabId) ?? []
    group.push(tab)
    groups.set(tab.parentTabId, group)
  }

  return [...groups.entries()].map(([parentTabId, surfaces], index) => {
    const localTabId = toWebTerminalSurfaceTabId(parentTabId)
    const existingLayout = existingLayoutsByTabId[localTabId]
    const requestedActiveLeafId =
      focusTarget?.parentTabId === parentTabId ? focusTarget.leafId : undefined
    const activeSurface =
      (requestedActiveLeafId
        ? surfaces.find((surface) => surface.leafId === requestedActiveLeafId)
        : undefined) ??
      (existingLayout?.activeLeafId
        ? surfaces.find((surface) => surface.leafId === existingLayout.activeLeafId)
        : undefined) ??
      surfaces.find((surface) => surface.isActive) ??
      surfaces[0]!
    const ptyIdForSurface = (handle: string): string =>
      terminalPtyMode === 'local' ? handle : toRemoteRuntimePtyId(handle, environmentId)
    const freshPtyIdsByLeafId = Object.fromEntries(
      surfaces
        .filter((surface): surface is ReadyTerminalSurface => surface.status === 'ready')
        .map((surface) => [surface.leafId, ptyIdForSurface(surface.terminal)])
    )
    const ptyIdsByLeafId = retainPendingTerminalBindings(
      surfaces,
      existingLayout,
      freshPtyIdsByLeafId,
      environmentId,
      terminalPtyMode
    )
    const layout = normalizeTerminalLayoutPtyOwnership(
      chooseRemoteTerminalLayout(surfaces, ptyIdsByLeafId, existingLayout, requestedActiveLeafId)
    ).snapshot
    const layoutPtyEntries = Object.entries(layout.ptyIdsByLeafId ?? {})
    const ptyIds = layoutPtyEntries.map(([, ptyId]) => ptyId)
    let retainedSurfaceByPrunedLeafId: Map<string, TerminalSurface> | undefined
    if (layoutPtyEntries.length < Object.keys(ptyIdsByLeafId).length) {
      const retainedLeafIdByPtyId = new Map(
        layoutPtyEntries.map(([leafId, ptyId]) => [ptyId, leafId])
      )
      const surfaceByLeafId = new Map(surfaces.map((surface) => [surface.leafId, surface]))
      retainedSurfaceByPrunedLeafId = new Map()
      for (const [leafId, ptyId] of Object.entries(ptyIdsByLeafId)) {
        const retainedLeafId = retainedLeafIdByPtyId.get(ptyId)
        if (retainedLeafId && retainedLeafId !== leafId) {
          const retainedSurface = surfaceByLeafId.get(retainedLeafId)
          if (retainedSurface) {
            retainedSurfaceByPrunedLeafId.set(leafId, retainedSurface)
          }
        }
      }
    }
    const launchAgent =
      activeSurface.launchAgent ?? surfaces.find((surface) => surface.launchAgent)?.launchAgent
    const ownerRecord = resolvePaneAgentOwnerRecord({
      launchAgent,
      hookAgent: activeSurface.agentStatus?.agentType,
      siblingHookAgent: surfaces.find((surface) => surface.agentStatus?.agentType)?.agentStatus
        ?.agentType
    })
    const existing =
      existingById.get(localTabId) ??
      existingById.get(parentTabId) ??
      surfaces
        .map((surface) => existingById.get(toWebTerminalSurfaceTabId(surface.id)))
        .find((tab): tab is TerminalTab => Boolean(tab))
    // Why: a headless host publishes the literal "Terminal" while an idle pane
    // has no live PTY. Keep the client's known title until a ready surface reports one.
    const hostTitle = activeSurface.title.trim() || surfaces[0]?.title.trim() || ''
    const hostTitleIsPlaceholder =
      hostTitle === '' || (activeSurface.status === 'pending-handle' && hostTitle === 'Terminal')
    const retainedTitle = existing?.title?.trim() || existing?.defaultTitle?.trim() || ''
    const title = normalizeCompatibleAgentTitleForOwner(
      (hostTitleIsPlaceholder ? retainedTitle || hostTitle : hostTitle) || 'Terminal',
      ownerRecord?.agent,
      { ownerIsLaunch: ownerRecord?.ownerIsLaunch === true }
    )
    const quickCommandLabel =
      activeSurface.quickCommandLabel?.trim() ||
      surfaces.find((surface) => surface.quickCommandLabel?.trim())?.quickCommandLabel?.trim() ||
      existing?.quickCommandLabel?.trim()
    // Why: startupCwd is host-owned launch metadata; once the host omits it, don't resurrect stale subdirectory intent.
    const startupCwd =
      activeSurface.startupCwd || surfaces.find((surface) => surface.startupCwd)?.startupCwd
    // Why: color/pin echo back through host snapshots, so prefer the client's own record and fall back to host only without a prior tab (avoids echo-window reverts).
    const hostColorSurface = surfaces.find((surface) => surface.color != null)
    const color = existing ? (existing.color ?? null) : (hostColorSurface?.color ?? null)
    const isPinned = existing
      ? existing.isPinned === true
      : surfaces.some((surface) => surface.isPinned)
    // Why: viewMode echoes back through host snapshots, so prefer the client's record during the echo window and adopt the host value only without a prior tab.
    const hostViewModeSurface = surfaces.find((surface) => surface.viewMode)
    const viewMode = existing ? existing.viewMode : hostViewModeSurface?.viewMode
    return {
      tab: {
        id: localTabId,
        ptyId: ptyIdsByLeafId[activeSurface.leafId] ?? null,
        worktreeId: snapshot.worktree,
        title,
        defaultTitle: existing?.defaultTitle ?? title,
        // Why: the host transport carries no generated title, so rebuilding the tab
        // without this dropped the client's agent-prompt label on every snapshot.
        ...(existing?.generatedTitle ? { generatedTitle: existing.generatedTitle } : {}),
        ...(existing?.aiVaultTitle ? { aiVaultTitle: existing.aiVaultTitle } : {}),
        ...(quickCommandLabel ? { quickCommandLabel } : {}),
        ...(startupCwd ? { startupCwd } : {}),
        customTitle: existing?.customTitle ?? null,
        color,
        isPinned,
        ...(viewMode ? { viewMode } : {}),
        sortOrder: sortOffset + index,
        createdAt: existing?.createdAt ?? now + index,
        // Why: launchAgent is host-owned lifecycle metadata; once the host omits it, don't resurrect stale startup intent.
        ...(launchAgent ? { launchAgent } : {})
      },
      hostTabId: parentTabId,
      ptyIds,
      layout,
      ...(retainedSurfaceByPrunedLeafId ? { retainedSurfaceByPrunedLeafId } : {})
    }
  })
}
