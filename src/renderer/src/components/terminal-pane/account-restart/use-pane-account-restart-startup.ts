import { useCallback } from 'react'
import { useAppStore } from '../../../store'
import { buildPaneAccountRestartStartup } from '@/lib/agent-session/accounts/agent-account-restart-startup'
import type { TerminalPaneCloseController } from '../layout/close/use-terminal-pane-close-actions'
import type { AccountRestartAgent } from '@/store/terminals/terminal-contracts'
import type { AgentProviderSessionMetadata } from '../../../../../shared/agent-session/lifecycle/agent-session-resume'

export function usePaneAccountRestartStartup({
  tabId,
  worktreeId
}: Pick<TerminalPaneCloseController, 'tabId' | 'worktreeId'>) {
  const buildAccountRestartStartup = useCallback(
    (
      agent: AccountRestartAgent,
      leafId: string,
      discovered?: AgentProviderSessionMetadata,
      continueWork?: boolean,
      warnsWhenHeld?: boolean
    ) =>
      buildPaneAccountRestartStartup(
        agent,
        {
          tabId,
          worktreeId,
          leafId,
          shellOverride: useAppStore
            .getState()
            .tabsByWorktree[worktreeId]?.find((tab) => tab.id === tabId)?.shellOverride
        },
        discovered,
        continueWork,
        warnsWhenHeld
      ),
    [tabId, worktreeId]
  )
  return { buildAccountRestartStartup }
}
