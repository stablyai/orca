import { useCallback } from 'react'
import type { Tab } from '../../../../shared/tab-types'
import { TOGGLE_TERMINAL_PANE_EXPAND_EVENT } from '@/constants/terminal'
import { activateTabGroupTab } from './tab-group-tab-activation'
import type { TabGroupWorktreeSnapshot } from './useTabGroupItemProjections'

export function useTabGroupActivationCommands({
  worktreeId,
  groupTabs,
  worktreeState
}: {
  groupId: string
  worktreeId: string
  groupTabs: Tab[]
  worktreeState: TabGroupWorktreeSnapshot
}) {
  const activateTerminal = useCallback(
    (terminalId: string) => {
      const item = groupTabs.find(
        (candidate) => candidate.entityId === terminalId && candidate.contentType === 'terminal'
      )
      if (item) {
        activateTabGroupTab(worktreeId, item, {
          activeLeafId: worktreeState.terminalLayoutsByTabId[terminalId]?.activeLeafId ?? null
        })
      }
    },
    [groupTabs, worktreeState.terminalLayoutsByTabId, worktreeId]
  )

  const toggleTerminalPaneExpand = useCallback(
    (terminalId: string) => {
      const item = groupTabs.find(
        (candidate) => candidate.entityId === terminalId && candidate.contentType === 'terminal'
      )
      if (!item) {
        return
      }
      // Why: the collapse icon stops pointer propagation, so activate here since the normal tab handler won't have run.
      activateTerminal(terminalId)
      requestAnimationFrame(() => {
        window.dispatchEvent(
          new CustomEvent(TOGGLE_TERMINAL_PANE_EXPAND_EVENT, {
            detail: { tabId: terminalId }
          })
        )
      })
    },
    [activateTerminal, groupTabs]
  )

  const activateEditor = useCallback(
    (tabId: string) => {
      const item = groupTabs.find((candidate) => candidate.id === tabId)
      if (item) {
        activateTabGroupTab(worktreeId, item)
      }
    },
    [groupTabs, worktreeId]
  )

  const activateBrowser = useCallback(
    (browserTabId: string) => {
      const item = groupTabs.find(
        (candidate) => candidate.entityId === browserTabId && candidate.contentType === 'browser'
      )
      if (item) {
        activateTabGroupTab(worktreeId, item)
      }
    },
    [groupTabs, worktreeId]
  )

  const activateAgentSession = activateEditor

  return {
    activateTerminal,
    toggleTerminalPaneExpand,
    activateEditor,
    activateBrowser,
    activateAgentSession
  }
}
