/**
 * The window's half of a launch pane's verdict: main derives it on the pane's spawn (or when it
 * takes a pane back) and sends it typed; the tab keeps what is final and forgets what is settled.
 */

import type { AgentLaunchPaneVerdictEvent } from '../../../shared/agent-launch-pane-verdict'
import { applyClosedTerminalLeafNotice } from '@/components/terminal-pane/closed-terminal-leaf-notice'
import { collectLeafIdsInOrder } from '@/components/terminal-pane/terminal-layout-leaf-ids'
import { useAppStore } from '@/store'
import { forgetAgentLaunchPanePrompt } from './agent-launch-pane-prompt'

export function applyAgentLaunchPaneVerdict(event: AgentLaunchPaneVerdictEvent): void {
  const { worktreeId, tabId, leafId, verdict } = event
  const state = useAppStore.getState()
  const tab = state.tabsByWorktree[worktreeId]?.find((candidate) => candidate.id === tabId)
  // Only a pane its tab says a launch laid out: a verdict never touches anything else.
  if (tab?.agentLaunchPane?.leafId !== leafId) {
    return
  }
  switch (verdict.kind) {
    case 'proceed':
      // Settled: the agent attached, or the pane is an ordinary terminal again.
      forgetAgentLaunchPanePrompt(tabId)
      state.setTabAgentLaunchPane(tabId, undefined)
      return
    case 'not-started':
    case 'unconfirmed': {
      const root = state.terminalLayoutsByTabId[tabId]?.root
      if (root && !collectLeafIdsInOrder(root).includes(leafId)) {
        // The user closed that pane: nothing is left for the outcome to describe.
        forgetAgentLaunchPanePrompt(tabId)
        state.setTabAgentLaunchPane(tabId, undefined)
        return
      }
      // Final for this pane, for the tab's life: no later spawn needs the launch record.
      state.setTabAgentLaunchPane(tabId, { ...tab.agentLaunchPane, outcome: verdict })
      return
    }
    case 'withdrawn': {
      forgetAgentLaunchPanePrompt(tabId)
      // The pane alone when the user split the tab while it waited; their split stays.
      if (state.terminalLayoutsByTabId[tabId]?.root?.type === 'leaf') {
        state.closeTab(tabId, {
          reason: 'cleanup',
          recordInteraction: false,
          captureRecentlyClosed: false
        })
      } else {
        state.setTabAgentLaunchPane(tabId, undefined)
        applyClosedTerminalLeafNotice(tabId, leafId)
      }
    }
  }
}
