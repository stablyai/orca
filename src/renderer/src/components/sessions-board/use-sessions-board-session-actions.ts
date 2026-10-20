import { useCallback } from 'react'
import { useShallow } from 'zustand/react/shallow'
import { useAppStore } from '@/store'
import type { AiVaultSession } from '../../../../shared/ai-vault-types'
import { revealSessionWorkspace } from '../right-sidebar/ai-vault-original-pane-actions'
import { useAiVaultSessionLaunchActions } from '../right-sidebar/ai-vault-session-launch-actions'
import type { SessionsBoardCardAvailability } from './sessions-board-card-availability'

export type SessionsBoardSessionActions = {
  jumpToSessionWorkspace: (session: AiVaultSession) => void
  resumeSessionInTerminal: (session: AiVaultSession) => void
}

/**
 * The board's two card actions, delegated to the machinery the Agent Session History panel
 * already uses. Nothing here decides *whether* an action is available — the availability map
 * does, and these read the target back out of it so a click can never run against a session
 * the card had drawn as disabled.
 */
export function useSessionsBoardSessionActions({
  availabilityById
}: {
  availabilityById: ReadonlyMap<string, SessionsBoardCardAvailability>
}): SessionsBoardSessionActions {
  const agentCmdOverrides = useAppStore((state) => state.settings?.agentCmdOverrides)
  const targetState = useAppStore(
    useShallow((state) => ({
      folderWorkspaces: state.folderWorkspaces,
      projectGroups: state.projectGroups,
      repos: state.repos,
      worktreesByRepo: state.worktreesByRepo
    }))
  )
  // Why both null: same contract as the availability pass — the board never resumes into
  // whichever workspace happens to be active. The target id always comes from the map.
  const { handleResume } = useAiVaultSessionLaunchActions({
    activeWorktree: null,
    activeWorktreeId: null,
    targetState,
    agentCmdOverrides
  })

  const jumpToSessionWorkspace = useCallback(
    (session: AiVaultSession): void => {
      const worktreeId = availabilityById.get(session.id)?.jumpWorktreeId
      if (worktreeId) {
        revealSessionWorkspace(worktreeId)
      }
    },
    [availabilityById]
  )

  const resumeSessionInTerminal = useCallback(
    (session: AiVaultSession): void => {
      const worktreeId = availabilityById.get(session.id)?.resumeWorktreeId
      if (worktreeId) {
        // handleResume activates the target workspace once the launch settles, so the resume
        // button lands the user there too.
        handleResume(session, worktreeId)
      }
    },
    [availabilityById, handleResume]
  )

  return { jumpToSessionWorkspace, resumeSessionInTerminal }
}
