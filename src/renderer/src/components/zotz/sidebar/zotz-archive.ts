import { toast } from 'sonner'
import { useAppStore } from '@/store/index'
import { translate } from '@/i18n/i18n'
import type { Worktree } from '../../../../../shared/worktree/types'

const SHOW_ARCHIVED_EVENT = 'zotz:show-archived'

export function onZotzShowArchived(listener: () => void): () => void {
  window.addEventListener(SHOW_ARCHIVED_EVENT, listener)
  return () => window.removeEventListener(SHOW_ARCHIVED_EVENT, listener)
}

export function setZotzConversationArchived(
  worktree: Pick<Worktree, 'id' | 'hostId'>,
  archived: boolean
): Promise<{ ok: true } | { ok: false; error: string }> {
  return useAppStore
    .getState()
    .updateWorktreeMeta(
      worktree.id,
      { isArchived: archived },
      worktree.hostId ? { executionHostId: worktree.hostId } : undefined
    )
}

/** Archives with an Undo and a way to the archived list, like Conductor after a merge. */
export async function archiveZotzConversation(
  worktree: Pick<Worktree, 'id' | 'hostId' | 'displayName'>,
  reason: 'user' | 'merged'
): Promise<void> {
  const result = await setZotzConversationArchived(worktree, true)
  if (!result.ok) {
    toast.error(
      translate('zotz.sidebar.archiveFailed', 'Could not archive: {{error}}', {
        error: result.error
      })
    )
    return
  }
  const title =
    reason === 'merged'
      ? translate('zotz.sidebar.archivedMerged', 'Merged and archived: {{name}}', {
          name: worktree.displayName
        })
      : translate('zotz.sidebar.archived', 'Conversation archived')
  toast.success(title, {
    action: {
      label: translate('zotz.sidebar.undo', 'Undo'),
      onClick: () => void setZotzConversationArchived(worktree, false)
    },
    cancel: {
      label: translate('zotz.sidebar.viewArchived', 'View archived'),
      onClick: () => window.dispatchEvent(new Event(SHOW_ARCHIVED_EVENT))
    }
  })
}
