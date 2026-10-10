// The tab's Session History move, shared by the tab menu and the terminal pane header button.

import { useShallow } from 'zustand/react/shallow'
import { useAppStore } from '../../store'
import type { AppState } from '@/store/types'
import type {
  AiVaultListArgs,
  AiVaultListResult,
  AiVaultSession
} from '../../../../shared/ai-vault-types'
import { useAiVaultSessionLaunchActions } from '../right-sidebar/ai-vault-session-launch-actions'
import {
  lookupTabSessionHistoryRow,
  resolveTabSessionSwitch,
  type TabSessionHistorySubject,
  type TabSessionSwitch
} from './tab-session-history-switch'

export type ResolvedTabSessionSwitch = {
  session: AiVaultSession
  move: TabSessionSwitch
}

/** The tab's history row and the move it offers; `undefined` when the lookup was cancelled. */
export async function lookupTabSessionSwitch(
  subject: TabSessionHistorySubject,
  getState: () => AppState,
  listSessions: (args: AiVaultListArgs) => Promise<AiVaultListResult>,
  options: { requestToken: string; isCancelled: () => boolean }
): Promise<ResolvedTabSessionSwitch | null | undefined> {
  const session = await lookupTabSessionHistoryRow(subject, listSessions, options)
  if (session === undefined || options.isCancelled()) {
    return undefined
  }
  // Ownership is read after the reply lands, so the move reflects the store at that moment.
  const move = session ? resolveTabSessionSwitch(getState(), session, subject) : null
  return session && move ? { session, move } : null
}

export function useTabSessionLaunchActions(
  worktreeId: string
): ReturnType<typeof useAiVaultSessionLaunchActions> {
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
  return useAiVaultSessionLaunchActions({
    activeWorktree: null,
    activeWorktreeId: worktreeId,
    targetState,
    agentCmdOverrides: targetState.settings?.agentCmdOverrides
  })
}
