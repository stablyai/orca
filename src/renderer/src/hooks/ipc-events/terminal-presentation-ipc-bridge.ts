import { requestBackgroundTerminalWorktreeMount } from '@/components/terminal/background-terminal-worktree-mount'
import { hasRegisteredRuntimeTerminalTab } from '@/runtime/sync-runtime-graph'
import { planMobileTerminalTabMount } from '@/lib/mobile-terminal-tab-mount'
import { resolveTerminalTabPtyOwnership } from '@/lib/terminal-tab-for-pty-id'
import { SPLIT_TERMINAL_PANE_EVENT } from '@/constants/terminal'
import type { SplitTerminalPaneDetail } from '@/constants/terminal'
import { singlePaneLayoutSnapshot } from '@/store/slices/terminal-helpers'
import { verifyTerminalRevealIdentity } from '@/lib/terminal-reveal-identity'
import { initialAgentTabViewModeProps } from '@/lib/native-chat-initial-view-mode'
import { getConnectionIdFromState } from '@/lib/connection-context'
import { isNativeChatTranscriptLocalReadable } from '@/lib/native-chat-transcript-readability'
import { tryMakePaneKey } from './agent-status-routing'
import { useAppStore } from '../../store'
import {
  activateExistingLeafInLayout,
  activateTerminalInitiatedWorktree,
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
        title,
        ptyId,
        activate,
        focus,
        presentation,
        surfaceOwner,
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
          const shouldActivate = terminalPresentation === 'focused'
          const shouldSurfaceOwner = terminalPresentation !== 'background' && surfaceOwner !== false
          if (shouldActivate) {
            activateTerminalInitiatedWorktree(store, worktreeId)
          }
          const worktreeTabs = store.tabsByWorktree[worktreeId] ?? []
          // Why: a split pane revealed from mobile is only bound in the persisted
          // layout until its pane mounts; missing it minted a duplicate tab (#10486).
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
          const isSplitReveal = Boolean(ptyId && tabId && leafId && splitFromLeafId)
          const splitTargetTab = isSplitReveal
            ? worktreeTabs.find((candidate) => candidate.id === tabId)
            : undefined
          if (isSplitReveal && !splitTargetTab) {
            throw new Error(`Terminal tab ${tabId} not found`)
          }
          const reusedTab = existingTab ?? splitTargetTab
          const tab =
            reusedTab ??
            (ptyId
              ? store.createTab(worktreeId, undefined, undefined, {
                  initialPtyId: ptyId,
                  activate: shouldActivate,
                  ...(launchAgent
                    ? {
                        launchAgent,
                        // Why: a paired client resolved explicit mode before PTY materialization; only omitted mode uses host defaults.
                        ...(viewMode
                          ? { viewMode }
                          : initialAgentTabViewModeProps(store.settings, {
                              agent: launchAgent,
                              nativeChatTranscriptIsLocalReadable:
                                isNativeChatTranscriptLocalReadable(
                                  getConnectionIdFromState(store, worktreeId)
                                )
                            }))
                      }
                    : {}),
                  ...(cwd ? { startupCwd: cwd } : {}),
                  // Why: CLI-spawned PTYs bake the pane key into env; adopt the same tab id so hook-event attribution keeps working.
                  ...(tabId !== undefined ? { id: tabId } : {})
                })
              : store.createTab(
                  worktreeId,
                  undefined,
                  undefined,
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
          // Why: a reused tab whose id differs from the hint breaks the PTY's baked-in paneKey attribution; warn during dev.
          if (tabId !== undefined && tab.id !== tabId) {
            console.warn(
              `[onCreateTerminal] tabId hint ${tabId} ignored for ptyId ${ptyId}; existing tab ${tab.id} adopted instead (hook attribution will degrade for this terminal)`
            )
          }
          if (shouldActivate) {
            store.setActiveTabType('terminal')
            store.setActiveTab(tab.id)
          }
          if (shouldSurfaceOwner) {
            store.revealWorktreeInSidebar(worktreeId)
            focusTerminalInitiatedTab(tab.id, leafId, worktreeId)
          }
          // Why: only stamp the runtime title on fresh tabs; reused tabs may have a user customTitle it would overwrite on focus.
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
              // Why: runtime split PTYs already carry the parent tab's paneKey, so reuse the tab instead of minting a collision tab.
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
              // Why: CLI/runtime PTYs emit hook events before the tab mounts, so the leaf must exist in layout for paneKey validation.
              const existingLayout = reusedTab
                ? activateExistingLeafInLayout(
                    store.terminalLayoutsByTabId?.[tab.id],
                    leafId,
                    ptyId,
                    title
                  )
                : null
              if (existingLayout) {
                store.updateTabPtyId(tab.id, ptyId)
                store.setTabLayout(tab.id, existingLayout)
              } else {
                store.setTabLayout(tab.id, singlePaneLayoutSnapshot(leafId, ptyId, title))
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
