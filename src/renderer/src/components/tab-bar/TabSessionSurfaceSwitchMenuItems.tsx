import { useEffect, useState } from 'react'
import { useShallow } from 'zustand/react/shallow'
import { DropdownMenuSeparator } from '@/components/ui/dropdown-menu'
import { createBrowserUuid } from '@/lib/browser-uuid'
import { useAppStore } from '../../store'
import type { AiVaultSession } from '../../../../shared/ai-vault-types'
import type { TerminalTab } from '../../../../shared/terminal-tab-types'
import { AiVaultSessionSurfaceSwitchMenuItems } from '../right-sidebar/AiVaultSessionSurfaceSwitchMenuItems'
import { useAiVaultSessionLaunchActions } from '../right-sidebar/ai-vault-session-launch-actions'
import {
  lookupTabSessionHistoryRow,
  resolveTabSessionHistorySubject,
  resolveTabSessionSwitch,
  type TabSessionHistorySubject,
  type TabSessionSwitch
} from './tab-session-history-switch'

type ResolvedTabSessionSwitch = {
  session: AiVaultSession
  move: TabSessionSwitch
}

function resolveMove(
  session: AiVaultSession | null,
  subject: TabSessionHistorySubject
): ResolvedTabSessionSwitch | null {
  const move = session ? resolveTabSessionSwitch(useAppStore.getState(), session, subject) : null
  return session && move ? { session, move } : null
}

// Mounted only while the menu is open, so the history lookup runs per right-click, not per tab.
function useTabSessionSwitch(
  tab: Pick<TerminalTab, 'id' | 'worktreeId' | 'launchAgent'>,
  structuredSessionId: string | undefined
): ResolvedTabSessionSwitch | null {
  const [subject] = useState(() =>
    resolveTabSessionHistorySubject(useAppStore.getState(), {
      tab: { id: tab.id, worktreeId: tab.worktreeId, launchAgent: tab.launchAgent },
      structuredSessionId
    })
  )
  // Only a fresh reply carries current chat ownership, so nothing is offered before it lands.
  const [resolved, setResolved] = useState<ResolvedTabSessionSwitch | null>(null)
  useEffect(() => {
    if (!subject) {
      return
    }
    let cancelled = false
    const requestToken = createBrowserUuid()
    void lookupTabSessionHistoryRow(subject, (args) => window.api.aiVault.listSessions(args), {
      requestToken,
      isCancelled: () => cancelled
    })
      .then((session) => {
        if (!cancelled && session !== undefined) {
          setResolved(resolveMove(session, subject))
        }
      })
      // A failed lookup only means the move is not offered; the rest of the menu is unaffected.
      .catch(() => {})
    return () => {
      cancelled = true
      void window.api.aiVault.cancelListSessions({ requestToken }).catch(() => {})
    }
  }, [subject])
  return resolved
}

/** The Session History row's "Resume in New Native Chat" / "Resume in New CLI", offered on the tab
 *  that shows that session and hidden wherever the row would not offer it. */
export function TabSessionSurfaceSwitchMenuItems({
  tab,
  structuredSessionId,
  leadingSeparator
}: {
  tab: Pick<TerminalTab, 'id' | 'worktreeId' | 'launchAgent'>
  structuredSessionId?: string
  leadingSeparator: boolean
}): React.JSX.Element | null {
  const resolved = useTabSessionSwitch(tab, structuredSessionId)
  const targetState = useAppStore(
    useShallow((state) => ({
      projects: state.projects,
      settings: state.settings,
      folderWorkspaces: state.folderWorkspaces,
      projectGroups: state.projectGroups,
      repos: state.repos,
      worktreesByRepo: state.worktreesByRepo
    }))
  )
  const launchActions = useAiVaultSessionLaunchActions({
    activeWorktree: null,
    activeWorktreeId: tab.worktreeId,
    targetState,
    agentCmdOverrides: targetState.settings?.agentCmdOverrides
  })
  if (!resolved) {
    return null
  }
  const { session, move } = resolved
  return (
    <>
      {leadingSeparator ? <DropdownMenuSeparator /> : null}
      <AiVaultSessionSurfaceSwitchMenuItems
        menuKind="dropdown"
        tooltipSide="right"
        onResumeInNewChat={
          move.action === 'resume-in-new-chat'
            ? () => launchActions.handleResumeInNewChat(session, move.worktreeId)
            : undefined
        }
        onResumeInNewCli={
          move.action === 'resume-in-new-cli'
            ? () => launchActions.handleResumeInNewCli(session, move.worktreeId)
            : undefined
        }
      />
    </>
  )
}
