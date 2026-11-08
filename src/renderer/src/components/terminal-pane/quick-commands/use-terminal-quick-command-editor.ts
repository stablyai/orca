import { useCallback } from 'react'
import { useAppStore } from '../../../store'
import { useRepoById } from '@/store/repos/use-repository-catalog'
import { FLOATING_TERMINAL_WORKTREE_ID } from '../../../../../shared/constants'
import { getRepoIdFromWorktreeId } from '../../../../../shared/worktree/id'
import type {
  TerminalQuickCommand,
  TerminalQuickCommandScope
} from '../../../../../shared/terminal/quick-commands/terminal-quick-command-types'
import { createTerminalQuickCommandDraft } from '@/components/terminal-quick-commands/TerminalQuickCommandDialog'
import { getCachedTerminalGroupIdForWorktree } from '../controller/tab-state/terminal-unified-tab-lookup'
import type { ExecutionHostId } from '../../../../../shared/execution-host'
import type { TerminalPaneStoreController } from '../controller/use-terminal-pane-store-bindings'

export function useTerminalQuickCommandEditor({
  worktreeId,
  tabId,
  setQuickCommandDraft,
  setQuickCommandEditorHostId,
  setQuickCommandEditorOpen,
  quickCommandEditorHostId
}: Pick<
  TerminalPaneStoreController,
  | 'worktreeId'
  | 'tabId'
  | 'setQuickCommandDraft'
  | 'setQuickCommandEditorHostId'
  | 'setQuickCommandEditorOpen'
  | 'quickCommandEditorHostId'
>) {
  const quickCommandRepoId =
    worktreeId === FLOATING_TERMINAL_WORKTREE_ID ? null : getRepoIdFromWorktreeId(worktreeId)
  const quickCommandRepo = useRepoById(quickCommandRepoId)
  const quickCommandRepoLabel = quickCommandRepo
    ? quickCommandRepo.displayName || quickCommandRepo.path
    : quickCommandRepoId
      ? 'This Repo'
      : null
  const quickCommandGroupId =
    useAppStore(
      (state) =>
        getCachedTerminalGroupIdForWorktree(state.unifiedTabsByWorktree, worktreeId, tabId) ??
        state.activeGroupIdByWorktree[worktreeId] ??
        null
    ) ?? null

  const openQuickCommandEditor = useCallback(
    (scope: TerminalQuickCommandScope, hostId: ExecutionHostId): void => {
      setQuickCommandDraft(createTerminalQuickCommandDraft(scope))
      setQuickCommandEditorHostId(hostId)
      setQuickCommandEditorOpen(true)
    },
    [setQuickCommandDraft, setQuickCommandEditorHostId, setQuickCommandEditorOpen]
  )
  const saveQuickCommand = useCallback(
    (command: TerminalQuickCommand): Promise<boolean> =>
      useAppStore.getState().upsertTerminalQuickCommand(quickCommandEditorHostId, command),
    [quickCommandEditorHostId]
  )
  return {
    quickCommandRepoId,
    quickCommandRepoLabel,
    quickCommandGroupId,
    openQuickCommandEditor,
    saveQuickCommand
  }
}
