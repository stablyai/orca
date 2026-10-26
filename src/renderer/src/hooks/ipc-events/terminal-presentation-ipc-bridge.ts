import { presentAgentLaunchTab } from '@/lib/agent-launch-tab-presentation'
import { requestBackgroundTerminalWorktreeMount } from '@/components/terminal/background-terminal-worktree-mount'
import { hasRegisteredRuntimeTerminalTab } from '@/runtime/mounted-terminal-tab-registry'
import { planMobileTerminalTabMount } from '@/lib/mobile-terminal-tab-mount'
import { resolveTerminalTabPtyOwnership } from '@/lib/terminal-tab-for-pty-id'
import { SPLIT_TERMINAL_PANE_EVENT } from '@/constants/terminal'
import type { SplitTerminalPaneDetail } from '@/constants/terminal'
import { singlePaneLayoutSnapshot } from '@/store/slices/terminal-helpers'
import { verifyTerminalRevealIdentity } from '@/lib/terminal-reveal-identity'
import { insertUnifiedTabAfterAnchor } from '@/lib/unified-tab-anchor-insertion'
import { tryMakePaneKey } from './agent-status-routing'
import { wasAgentLaunchPaneClosedByUser } from '@/lib/agent-launch-pane-closes'
import { revealWorkspaceSurface } from '@/lib/workspace-surface-reveal'
import { useAppStore } from '../../store'
import { ORCA_LAYOUT_OWNER_IS_MAIN } from '../../../../shared/layout-owner-switch'
import {
  activateExistingLeafInLayout,
  addSplitLeafToLayout,
  focusTerminalInitiatedTab,
  resolveTerminalPresentation
} from './terminal-command-state'

export function registerTerminalPresentationIpcBridge(unsubs: (() => void)[]): void {
  unsubs.push(
    window.api.ui.onCreateTerminal(
      ({
        requestId,
        worktreeId,
        command,
        cwd,
        env,
        launchConfig,
        resumeProviderSession,
        launchToken,
        launchAgent,
        viewMode,
        targetGroupId,
        afterTabId,
        shellOverride,
        title,
        ptyId,
        activate,
        focus,
        presentation,
        surfaceOwner,
        agentLaunchViewer,
        tabId,
        leafId,
        splitFromLeafId,
        splitDirection,
        splitTelemetrySource
      }) => {
        try {
          const store = useAppStore.getState()
          const terminalPresentation = resolveTerminalPresentation({
            presentation,
            activate,
            focus
          })
          const shouldActivate =
            agentLaunchViewer === undefined && terminalPresentation === 'focused'
          const shouldSurfaceOwner =
            agentLaunchViewer === undefined &&
            terminalPresentation !== 'background' &&
            surfaceOwner !== false
          const worktreeTabs = store.tabsByWorktree[worktreeId] ?? []
          const isSplitReveal = Boolean(ptyId && tabId && leafId && splitFromLeafId)
          const splitTargetTab = isSplitReveal
            ? worktreeTabs.find((candidate) => candidate.id === tabId)
            : undefined
          // Why: before activating, so a split into a tab this window lacks does not navigate.
          if (isSplitReveal && !splitTargetTab) {
            throw new Error(`Terminal tab ${tabId} not found`)
          }
          if (shouldActivate) {
            revealWorkspaceSurface(store, worktreeId)
          }
          if (ptyId && tabId && leafId && wasAgentLaunchPaneClosedByUser(tabId, leafId)) {
            // User close wins while launch waits; stop its agent, tolerating a second kill after host retirement.
            window.api.pty.kill(ptyId).catch(() => {})
            throw new Error('agent_launch_tab_closed')
          }
          // Mobile-revealed splits may exist only in persisted layout before mount; recognize them to avoid duplicate tabs (#10486).
          const ownership = ptyId
            ? resolveTerminalTabPtyOwnership(
                store,
                worktreeId,
                ptyId,
                tabId !== undefined ? { preferTabId: tabId } : {}
              )
            : { kind: 'none' as const }
          const existingTab =
            ownership.kind === 'owned'
              ? worktreeTabs.find((candidate) => candidate.id === ownership.tabId)
              : undefined
          let reusedTab = existingTab ?? splitTargetTab
          // Reuse main’s frame-drawn tab even if stale records make legacy ownership ambiguous.
          const frameDrawnTab =
            ORCA_LAYOUT_OWNER_IS_MAIN && !reusedTab && tabId !== undefined
              ? worktreeTabs.find((candidate) => candidate.id === tabId)
              : undefined
          if (frameDrawnTab) {
            reusedTab = frameDrawnTab
          }
          const tab =
            reusedTab ??
            (ptyId
              ? store.createTab(worktreeId, targetGroupId, shellOverride, {
                  initialPtyId: ptyId,
                  activate:
                    shouldActivate ||
                    agentLaunchViewer === 'focus-window' ||
                    agentLaunchViewer === 'focus-in-workspace',
                  ...(surfaceOwner === false && terminalPresentation === 'background'
                    ? { recordInteraction: false }
                    : {}),
                  ...(launchAgent
                    ? {
                        launchAgent,
                        // Why: a paired client resolved explicit mode before PTY materialization; only omitted mode uses host defaults.
                        ...(viewMode ? { viewMode } : {})
                      }
                    : {}),
                  ...(cwd ? { startupCwd: cwd } : {}),
                  // Why: CLI-spawned PTYs bake the pane key into env; adopt the same tab id so hook-event attribution keeps working.
                  ...(tabId !== undefined ? { id: tabId } : {}),
                  ...(ORCA_LAYOUT_OWNER_IS_MAIN && leafId ? { initialLeafId: leafId } : {})
                })
              : store.createTab(
                  worktreeId,
                  targetGroupId,
                  shellOverride,
                  shouldActivate
                    ? cwd
                      ? { startupCwd: cwd }
                      : undefined
                    : {
                        activate: false,
                        recordInteraction: false,
                        ...(cwd ? { startupCwd: cwd } : {})
                      }
                ))
          if (afterTabId) {
            const unifiedTabs = useAppStore.getState().unifiedTabsByWorktree[worktreeId] ?? []
            const createdUnified = unifiedTabs.find((item) => item.entityId === tab.id)?.id
            const anchorUnified = unifiedTabs.find(
              (item) => item.id === afterTabId || item.entityId === afterTabId
            )?.id
            if (createdUnified && anchorUnified) {
              insertUnifiedTabAfterAnchor(worktreeId, createdUnified, anchorUnified)
            }
          }
          // Different reused IDs break the PTY’s baked-in paneKey attribution; warn in dev.
          if (tabId !== undefined && tab.id !== tabId) {
            console.warn(
              `[onCreateTerminal] tabId hint ${tabId} ignored for ptyId ${ptyId}; existing tab ${tab.id} adopted instead (hook attribution will degrade for this terminal)`
            )
          }
          if (shouldActivate) {
            store.setActiveTabType('terminal', worktreeId)
            store.setActiveTab(tab.id)
          } else if (shouldSurfaceOwner) {
            store.revealWorktreeInSidebar(worktreeId)
          }
          if (shouldSurfaceOwner) {
            focusTerminalInitiatedTab(tab.id, leafId, worktreeId)
          }
          if (agentLaunchViewer) {
            presentAgentLaunchTab(agentLaunchViewer, worktreeId, tab.id, leafId)
          }
          // Apply runtime titles only to fresh tabs or focus would overwrite reused tabs’ custom titles.
          if (title && !reusedTab) {
            store.setTabCustomTitle(tab.id, title, { recordInteraction: false })
          }
          if (leafId && ptyId) {
            const launchPaneKey = tryMakePaneKey(tab.id, leafId)
            if (launchConfig) {
              if (launchPaneKey) {
                store.registerAgentLaunchConfig(launchPaneKey, launchConfig, {
                  ...(launchAgent ? { agentType: launchAgent } : {}),
                  ...(launchToken ? { launchToken } : {}),
                  tabId: tab.id,
                  leafId
                })
              }
            } else if (!splitFromLeafId && launchPaneKey) {
              store.clearAgentLaunchConfig(launchPaneKey)
            }
            if (splitFromLeafId) {
              // Runtime splits already use their parent paneKey; reuse the tab rather than minting a colliding ID.
              store.updateTabPtyId(tab.id, ptyId)
              const existingLayout = store.terminalLayoutsByTabId?.[tab.id]
              const sourcePtyId = existingLayout?.ptyIdsByLeafId?.[splitFromLeafId]
              store.setTabLayout(
                tab.id,
                addSplitLeafToLayout(
                  existingLayout,
                  splitFromLeafId,
                  leafId,
                  ptyId,
                  splitDirection ?? 'horizontal',
                  title,
                  shouldActivate
                )
              )
              window.dispatchEvent(
                new CustomEvent<SplitTerminalPaneDetail>(SPLIT_TERMINAL_PANE_EVENT, {
                  detail: {
                    tabId: tab.id,
                    worktreeId,
                    paneRuntimeId: -1,
                    direction: splitDirection ?? 'horizontal',
                    sourceLeafId: splitFromLeafId,
                    sourcePtyId,
                    telemetrySource: splitTelemetrySource,
                    newLeafId: leafId,
                    ptyId
                  }
                })
              )
            } else {
              const paneTitle = ORCA_LAYOUT_OWNER_IS_MAIN ? undefined : title
              // Why: CLI/runtime PTYs emit hook events before the tab mounts, so the leaf must exist in layout for paneKey validation.
              const existingLayout = reusedTab
                ? activateExistingLeafInLayout(
                    store.terminalLayoutsByTabId?.[tab.id],
                    leafId,
                    ptyId,
                    paneTitle
                  )
                : null
              if (existingLayout) {
                store.updateTabPtyId(tab.id, ptyId)
                store.setTabLayout(tab.id, existingLayout)
              } else {
                store.setTabLayout(tab.id, singlePaneLayoutSnapshot(leafId, ptyId, paneTitle))
              }
            }
          }
          if (command) {
            store.queueTabStartupCommand(tab.id, {
              command,
              ...(env ? { env } : {}),
              ...(launchConfig ? { launchConfig } : {}),
              ...(resumeProviderSession ? { resumeProviderSession } : {}),
              ...(launchToken ? { launchToken } : {}),
              ...(launchAgent ? { launchAgent } : {})
            })
          }
          if (ptyId && terminalPresentation === 'background') {
            requestBackgroundTerminalWorktreeMount({ worktreeId, tabIds: [tab.id] })
          }
          if (requestId) {
            // Why: attest the actual binding; recovery callers compare it with their expected identity.
            const identity =
              ptyId && tabId && leafId
                ? verifyTerminalRevealIdentity(useAppStore.getState(), {
                    worktreeId,
                    tabId: tab.id,
                    leafId,
                    ptyId
                  })
                : undefined
            window.api.ui.replyTerminalCreate({
              requestId,
              tabId: tab.id,
              title: title ?? tab.title,
              ...(identity ? { identity } : {})
            })
          }
        } catch (err) {
          if (!requestId) {
            throw err
          }
          window.api.ui.replyTerminalCreate({
            requestId,
            error: err instanceof Error ? err.message : 'Terminal reveal failed'
          })
        }
      }
    )
  )

  // Why: background-mount a mobile-subscribed tab's PTY without navigating the desktop (STA-1840).
  unsubs.push(
    window.api.ui.onRequestTerminalTabMount(({ worktreeId, tabId, ptyId }) => {
      if (!worktreeId) {
        return
      }
      // Why: synthetic pty handles need persisted-tab resolution; a miss must not mount every saved tab in a hidden worktree.
      const mount = planMobileTerminalTabMount(
        useAppStore.getState(),
        {
          worktreeId,
          ...(tabId ? { tabId } : {}),
          ...(ptyId ? { ptyId } : {})
        },
        {
          isTabMounted: (tabId, targetWorktreeId) =>
            hasRegisteredRuntimeTerminalTab(tabId, targetWorktreeId)
        }
      )
      if (mount) {
        requestBackgroundTerminalWorktreeMount(mount)
      }
    })
  )

  // Why: CLI-driven terminal creation waits for the tabId reply so it can hand the caller a usable handle immediately.
}
