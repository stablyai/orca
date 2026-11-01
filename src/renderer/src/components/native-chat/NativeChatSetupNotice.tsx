import type { ExecutionHostId } from '../../../../shared/execution-host'
import { useAppStore } from '@/store'
import { getExecutionHostIdForWorktree } from '@/lib/worktree-runtime-owner'
import { getRepoIdFromWorktreeId } from '@/store/slices/worktree-helpers'
import { openSetupScriptSettings } from '../sidebar/open-setup-script-settings'
import { Button } from '../ui/button'

export function NativeChatSetupNotice({
  worktreeId,
  executionHostId
}: {
  worktreeId: string | null
  executionHostId?: ExecutionHostId
}): React.JSX.Element | null {
  if (!worktreeId) {
    return null
  }
  return (
    <div
      // The ghost settings link inherits this faint color; the message sets its own.
      className="flex flex-1 flex-col items-center justify-center gap-3 p-6 text-center text-chat-foreground-faint"
      role="status"
    >
      <p className="text-sm text-chat-foreground">Waiting for setup script to complete</p>
      <Button
        type="button"
        variant="ghost"
        size="xs"
        onClick={() => {
          const state = useAppStore.getState()
          openSetupScriptSettings({
            ...state,
            repoId: getRepoIdFromWorktreeId(worktreeId),
            hostId: executionHostId ?? getExecutionHostIdForWorktree(state, worktreeId)
          })
        }}
      >
        Change in settings
      </Button>
    </div>
  )
}
