import { useAppStore } from '@/store/index'
import { useRunningTerminalCloseConfirmStore } from '@/store/slices/tabs/closing/running-terminal-close-confirm'
import CloseTerminalDialog from './CloseTerminalDialog'
import { findWorktreeById } from '@/store/github/refresh/worktree-refresh'
import { resolveWorktreeDisplayName } from '@/lib/workspace/display/worktree-default-display-name'
import { runSleepWorktree } from '@/components/sidebar/workspace-actions/sleep/sleep-worktree-flow'
import { revalidateTerminalCloseSleep } from '@/components/terminal/tab-lifecycle/terminal-close-sleep'
import { toast } from 'sonner'
import { translate } from '@/i18n/i18n'

async function sleepInstead(worktreeId: string, terminalTabId: string): Promise<void> {
  if (!(await revalidateTerminalCloseSleep(worktreeId, terminalTabId))) {
    toast.error(
      translate(
        'auto.components.sidebar.sleep.worktree.flow.8bc3fc0671',
        'Failed to sleep workspace'
      )
    )
    return
  }
  await runSleepWorktree(worktreeId)
}

export default function RunningTerminalCloseDialogSurface(): React.JSX.Element {
  const request = useRunningTerminalCloseConfirmStore((state) => state.runningTerminalCloseConfirm)
  const confirmClose = useRunningTerminalCloseConfirmStore(
    (state) => state.confirmRunningTerminalClose
  )
  const confirmAllCloses = useRunningTerminalCloseConfirmStore(
    (state) => state.confirmAllRunningTerminalCloses
  )
  const dismissClose = useRunningTerminalCloseConfirmStore(
    (state) => state.dismissRunningTerminalClose
  )
  const updateSettings = useAppStore((state) => state.updateSettings)
  // Process probes can overlap the synchronous pinned queue; wait instead of stacking modal focus traps.
  const pinnedRequest = useAppStore((state) => state.pinnedTabCloseConfirm)
  const worktreeId = request?.worktreeId
  const workspaceName = useAppStore((state) => {
    const worktree = worktreeId ? findWorktreeById(state, worktreeId) : null
    return worktree ? resolveWorktreeDisplayName(worktree) : undefined
  })

  return (
    <CloseTerminalDialog
      open={request !== null && pinnedRequest === null}
      copyKind={request?.copyKind ?? 'command'}
      // Pass the queued subject so checkbox reset runs even while the dialog stays open.
      {...(request ? { subjectKey: request.terminalTabId } : {})}
      workspaceName={workspaceName}
      // Why cancel first: the tab must stay listed, or sleep drops the agent's resume record.
      {...(request?.canSleepInstead && worktreeId
        ? {
            onSleepInstead: () => {
              if (dismissClose()) {
                void sleepInstead(worktreeId, request.terminalTabId)
              }
            }
          }
        : {})}
      onCancel={dismissClose}
      onConfirm={(dontAskAgain) => {
        if (dontAskAgain) {
          void updateSettings({ skipCloseTerminalWithRunningProcessConfirm: true })
          // Why: the user just opted out of this prompt; a queued one must not still appear.
          confirmAllCloses()
          return
        }
        confirmClose()
      }}
    />
  )
}
