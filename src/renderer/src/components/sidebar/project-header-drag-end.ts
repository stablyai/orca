import type { ProjectHeaderDropPreview } from './project-header-drop'
import { suppressClickAfterProjectHeaderDrag } from './project-header-drag-click-suppression'
import type {
  ProjectHeaderDragSession,
  UseRepoHeaderDragArgs
} from './project-header-drag-contract'
import { settleProjectHeaderDrop } from './project-header-drop-settle'
import type { Repo } from '../../../../shared/types'

export function endProjectHeaderDrag(args: {
  commit: boolean
  session: ProjectHeaderDragSession | null
  dropIndex: number | null
  dropPreview: ProjectHeaderDropPreview | null
  orderedRepoIds: readonly string[]
  repoById: ReadonlyMap<string, Repo>
  usesProjectGroupOrdering: boolean
  onCommitRepoOrder: UseRepoHeaderDragArgs['onCommitRepoOrder']
  onCommitProjectGroupOrder: UseRepoHeaderDragArgs['onCommitProjectGroupOrder']
  onSettle: (offsetY: number) => void
  onFinish: () => void
  onClickSwallowTimeout: (timeout: ReturnType<typeof setTimeout> | null) => void
}): void {
  const { session } = args
  if (!session) {
    args.onFinish()
    return
  }
  try {
    session.handleEl.releasePointerCapture(session.pointerId)
  } catch {
    // capture may already be released (pointercancel, element unmounted)
  }
  if (session.promoted) {
    args.onClickSwallowTimeout(
      suppressClickAfterProjectHeaderDrag(session.handleEl, () => args.onClickSwallowTimeout(null))
    )
  }
  if (!args.commit || !session.promoted || args.dropIndex === null) {
    args.onFinish()
    return
  }

  const sourceRect = session.headerRects.find((rect) => rect.repoId === session.repoId)
  settleProjectHeaderDrop({
    session,
    sidebarDropIndex: args.dropIndex,
    orderedRepoIds: args.orderedRepoIds,
    repoById: args.repoById,
    usesProjectGroupOrdering: args.usesProjectGroupOrdering,
    onCommitRepoOrder: args.onCommitRepoOrder,
    onCommitProjectGroupOrder: args.onCommitProjectGroupOrder,
    sourceTop: sourceRect?.top ?? null,
    dropPlaceholderY: args.dropPreview?.dropPlaceholderY ?? null,
    onSettle: args.onSettle,
    onFinish: args.onFinish
  })
}
