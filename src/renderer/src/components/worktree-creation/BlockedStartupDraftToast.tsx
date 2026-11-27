import { useEffect } from 'react'
import { toast } from 'sonner'
import { copyDroppedTextAction } from '@/lib/agent-session/launch/prompt/blocked-agent-startup-notice'
import { getResolvedExecutionHostIdForWorktree } from '@/lib/workspace/ownership/resolved-worktree-execution-host'
import { useAppStore } from '@/store'
import { useTranslate } from '@/i18n/use-translate'
import { LOCAL_EXECUTION_HOST_ID } from '../../../../shared/execution-host/execution-host'

export function BlockedStartupDraftToast(): null {
  const t = useTranslate()
  const worktreeId = useAppStore((state) =>
    getResolvedExecutionHostIdForWorktree(state, state.activeWorktreeId) === LOCAL_EXECUTION_HOST_ID
      ? state.activeWorktreeId
      : null
  )
  useEffect(() => {
    const watch = window.api?.worktrees?.watchBlockedStartupDraft
    if (!worktreeId || !watch) {
      return
    }
    const id = `blocked-startup-draft:${worktreeId}`
    const unwatch = watch(worktreeId, ({ text }) => {
      toast.message(
        t(
          'worktree.creation.startupDraftNotDelivered',
          'The startup prompt wasn’t delivered. Your draft is still available here.'
        ),
        {
          id,
          description: text,
          classNames: { description: 'max-h-40 overflow-y-auto whitespace-pre-wrap break-words' },
          closeButton: true,
          duration: Infinity,
          ...copyDroppedTextAction(text)
        }
      )
    })
    return () => {
      unwatch()
      toast.dismiss(id)
    }
  }, [t, worktreeId])
  return null
}
