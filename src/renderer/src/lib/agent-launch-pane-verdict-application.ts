/** Apply main’s typed spawn/takeback verdicts, retaining final pane outcomes until session cleanup. */

import type { AgentLaunchPaneVerdictEvent } from '../../../shared/agent-launch-pane-verdict'
import { applyClosedTerminalLeafNotice } from '@/components/terminal-pane/closed-terminal-leaf-notice'
import { collectLeafIdsInOrder } from '@/components/terminal-pane/terminal-layout-leaf-ids'
import { useAppStore } from '@/store'
import { forgetAgentLaunchPanePrompt } from './agent-launch-pane-prompt'
import { settleAgentLaunchPaneStart } from './agent-launch-pane-start'
import {
  applyVerdictToUndrawnLaunchTab,
  releaseMainWrittenLaunchTab
} from './agent-launch-tab-main-written'

export function applyAgentLaunchPaneVerdict(event: AgentLaunchPaneVerdictEvent): void {
  const { worktreeId, tabId, leafId, verdict } = event
  const state = useAppStore.getState()
  const tab = state.tabsByWorktree[worktreeId]?.find((candidate) => candidate.id === tabId)
  // A main-written tab this window does not draw yet keeps the verdict until it draws.
  if (!tab && applyVerdictToUndrawnLaunchTab(event)) {
    return
  }
  // Only a pane its tab says a launch laid out: a verdict never touches anything else.
  if (tab?.agentLaunchPane?.leafId !== leafId) {
    return
  }
  if (verdict.kind !== 'proceed') {
    settleAgentLaunchPaneStart(tabId, leafId, null)
  }
  switch (verdict.kind) {
    case 'proceed':
      releaseMainWrittenLaunchTab(tabId)
      forgetAgentLaunchPanePrompt(tabId)
      state.setTabAgentLaunchPane(tabId, undefined)
      return
    case 'not-started':
    case 'unconfirmed': {
      const root = state.terminalLayoutsByTabId[tabId]?.root
      if (root && !collectLeafIdsInOrder(root).includes(leafId)) {
        forgetAgentLaunchPanePrompt(tabId)
        state.setTabAgentLaunchPane(tabId, undefined)
        return
      }
      state.setTabAgentLaunchPane(tabId, { ...tab.agentLaunchPane, outcome: verdict })
      return
    }
    case 'withdrawn': {
      forgetAgentLaunchPanePrompt(tabId)
      if (releaseMainWrittenLaunchTab(tabId)) {
        state.setTabAgentLaunchPane(tabId, undefined)
        return
      }
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
