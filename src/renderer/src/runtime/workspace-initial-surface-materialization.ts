import type { PreloadApi } from '../../../preload/api-types'
import { ORCA_LAYOUT_OWNER_IS_MAIN } from '../../../shared/layout-owner-switch'
import { hasClosedTerminalTabRecord } from '../../../shared/closed-terminal-tab-tombstones'
import { isTerminalLeafId, makePaneKey } from '../../../shared/stable-pane-id'
import { wasAgentLaunchPaneClosedByUser } from '../lib/agent-launch-pane-closes'
import { indexTerminalSurfaceBindings } from '../lib/terminal-surface-binding-index'
import { bindLivePtyToExactSurface } from '../lib/worktree-agent-live-surface-adoption'
import { noteHostCreatedLaunchTargets } from '../lib/structured-agent-session-launch-prompt'
import { markStructuredAgentSessionLaunchesPublished } from '../lib/structured-agent-session-launch-publication'
import { useAppStore } from '../store'
import { createTerminalTabCreationActions } from '../store/terminals/terminal-tab-creation'
import { createTerminalLayoutActions } from '../store/terminals/terminal-layout-state'
import { createTerminalPtyBindingActions } from '../store/terminals/terminal-pty-bindings'
import { isValidHostTerminalTabId } from '../../../shared/terminal-tab-id'
import type { TerminalStoreGet, TerminalStoreSet } from '../store/terminals/terminal-state'
import { applyLocalStructuredSessionTabSnapshots } from './local-structured-session-tabs-sync/snapshot-apply'
import { LOCAL_STRUCTURED_SESSION_OWNER } from './local-structured-session-owner'
import { isWebSessionCloseIntentPending } from './web-session-close-intent'
import { framesDrawWorkspace } from './workspace-layout-frame-drawn-workspaces'
import { applyWebSessionTabsStorePatch } from './web-session-tabs-sync/store-patch'
import {
  chooseRemoteTerminalLayout,
  isReadyTerminalTab
} from './web-session-tabs-sync/terminal-surfaces'
import type { RuntimeMobileSessionTabsResult } from '../../../shared/runtime-types'

type TerminalProvision = Parameters<Parameters<PreloadApi['ui']['onCreateTerminal']>[0]>[0]

/** Publish complete initial state and its ancillary terminal in one observable store commit. */
export function materializeWorkspaceInitialSurface(
  provision: TerminalProvision,
  options: { appendAncillary?: boolean } = {}
): string | undefined {
  const snapshot = provision.initialWorkspaceTopology
  if (!snapshot || snapshot.worktree !== provision.worktreeId) {
    return
  }
  let ancillaryTabId: string | undefined
  const accepted: RuntimeMobileSessionTabsResult[] = []
  const acceptedSessions: { worktreeId: string; sessionId: string }[] = []
  const afterCommit: (() => void)[] = []
  const settle = applyWebSessionTabsStorePatch(
    (current) => {
      let staged = current
      const set: TerminalStoreSet = (update) => {
        staged = { ...staged, ...(typeof update === 'function' ? update(staged) : update) }
      }
      const get: TerminalStoreGet = () => ({
        ...staged,
        ...createTerminalTabCreationActions(set, get, useAppStore.subscribe),
        ...createTerminalLayoutActions(set, get),
        ...createTerminalPtyBindingActions(set, get),
        bumpWorktreeActivity: (worktreeId: string) => {
          afterCommit.push(() => current.bumpWorktreeActivity(worktreeId))
        }
      })
      const closed = (tabId: string, leafId: string) =>
        wasAgentLaunchPaneClosedByUser(tabId, leafId) ||
        hasClosedTerminalTabRecord(
          current.closedTerminalTabTombstonesByTabId,
          tabId,
          snapshot.worktree
        ) ||
        isWebSessionCloseIntentPending(
          { environmentId: LOCAL_STRUCTURED_SESSION_OWNER },
          snapshot.worktree,
          tabId,
          Date.now()
        )
      const terminals = snapshot.tabs
        .filter(isReadyTerminalTab)
        .filter(
          (tab) =>
            isValidHostTerminalTabId(tab.parentTabId) &&
            isTerminalLeafId(tab.leafId) &&
            !closed(tab.parentTabId, tab.leafId)
        )
      const materializedNativeTabIds = new Set<string>()
      const framesDraw = ORCA_LAYOUT_OWNER_IS_MAIN ? framesDrawWorkspace(current) : undefined
      staged = applyLocalStructuredSessionTabSnapshots(staged, [snapshot], undefined, undefined, {
        reacceptCurrentVersion: true,
        framesDraw,
        onAcceptedTopology: (topology) => accepted.push(topology),
        onAcceptedAgentSession: (worktreeId, sessionId) =>
          acceptedSessions.push({ worktreeId, sessionId })
      })
      if (accepted.length > 0 && terminals.length > 0 && !framesDraw?.(snapshot.worktree)) {
        // The selected native agent must exist before another terminal can become the first row.
        terminals.sort(
          (a, b) =>
            Number(b.id === snapshot.activeTabId || b.isActive) -
            Number(a.id === snapshot.activeTabId || a.isActive)
        )
        const bindings = indexTerminalSurfaceBindings(staged)
        const terminalsByTab = new Map<string, typeof terminals>()
        for (const terminal of terminals) {
          const siblings = terminalsByTab.get(terminal.parentTabId) ?? []
          siblings.push(terminal)
          terminalsByTab.set(terminal.parentTabId, siblings)
        }
        for (const terminal of terminals) {
          if (!isTerminalLeafId(terminal.leafId)) {
            continue
          }
          const known = bindings.owners
            .get(terminal.parentTabId)
            ?.some((owner) => owner.ownerWorktreeId === snapshot.worktree)
          const previousTabs = staged.tabsByWorktree[snapshot.worktree] ?? []
          if (
            !bindLivePtyToExactSurface(
              get(),
              snapshot.worktree,
              {
                tabId: terminal.parentTabId,
                paneKey: makePaneKey(terminal.parentTabId, terminal.leafId),
                ptyId: terminal.terminal
              },
              {
                launchAgent: terminal.launchAgent,
                viewMode: terminal.viewMode,
                startupCwd: terminal.startupCwd
              },
              bindings
            )
          ) {
            continue
          }
          if (!known) {
            bindings.removeMissingOwners(
              snapshot.worktree,
              previousTabs,
              staged.tabsByWorktree[snapshot.worktree] ?? []
            )
            materializedNativeTabIds.add(terminal.parentTabId)
            if (terminal.title) {
              afterCommit.push(() =>
                useAppStore
                  .getState()
                  .setTabCustomTitle(terminal.parentTabId, terminal.customTitle ?? terminal.title, {
                    recordInteraction: false
                  })
              )
            }
            const siblings = terminalsByTab.get(terminal.parentTabId) ?? []
            get().setTabLayout(
              terminal.parentTabId,
              chooseRemoteTerminalLayout(
                siblings,
                Object.fromEntries(siblings.map((tab) => [tab.leafId, tab.terminal]))
              )
            )
          }
        }
      }
      const ptyId = provision.ptyId
      const existing = staged.tabsByWorktree[provision.worktreeId]?.find(
        (tab) =>
          tab.id === provision.tabId ||
          (ptyId && (tab.ptyId === ptyId || staged.ptyIdsByTabId[tab.id]?.includes(ptyId)))
      )
      if (existing && materializedNativeTabIds.has(existing.id)) {
        ancillaryTabId = existing.id
      }
      if (
        options.appendAncillary !== false &&
        !existing &&
        !(provision.tabId && provision.leafId && closed(provision.tabId, provision.leafId))
      ) {
        ancillaryTabId = get().createTab(
          provision.worktreeId,
          provision.targetGroupId,
          provision.shellOverride,
          {
            ...(provision.tabId ? { id: provision.tabId } : {}),
            ...(provision.leafId ? { initialLeafId: provision.leafId } : {}),
            ...(provision.ptyId ? { initialPtyId: provision.ptyId } : {}),
            ...(provision.cwd ? { startupCwd: provision.cwd } : {}),
            ...(provision.launchAgent ? { launchAgent: provision.launchAgent } : {}),
            ...(provision.viewMode ? { viewMode: provision.viewMode } : {}),
            activate: false,
            recordInteraction: false
          }
        ).id
      }
      return staged
    },
    { frames: [] }
  )
  settle()
  for (const topology of accepted) {
    noteHostCreatedLaunchTargets('local', topology, useAppStore.getState)
  }
  markStructuredAgentSessionLaunchesPublished('local', acceptedSessions)
  for (const effect of afterCommit) {
    effect()
  }
  return ancillaryTabId
}
