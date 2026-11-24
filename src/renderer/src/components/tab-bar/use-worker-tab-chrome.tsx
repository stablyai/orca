import { indexedWorkerTab } from './worker-tab-index'
import { useCallback, useRef } from 'react'
import { Pin } from 'lucide-react'
import { useAppStore } from '@/store/index'
import { useTranslate } from '@/i18n/use-translate'
import { selectWorkerTabStripState } from './worker-tab-presentation'
import { isWorkerTabKnownRunning } from './worker-tab-run-state'
import { keepWorkerTab } from './worker-tab-hide'
import { CoordinatorWorkersBadge } from './CoordinatorWorkersBadge'

export type WorkerTabChrome = {
  /** Italic, like a preview tab, while this worker is its pane's peek. */
  titleClassName: string
  ariaDescription: string | undefined
  /** The close button's name: a worker's × hides it. */
  closeLabel: string | null
  /** Double-click keeps a peeked worker instead of renaming it. */
  keepOnDoubleClick: boolean
  keep: () => void
  keepButton: React.ReactNode
  badge: React.ReactNode
  /** The tab root, so focus can return to it when the badge leaves. */
  setTabRoot: (node: HTMLDivElement | null) => void
}

export function useWorkerTabChrome({
  worktreeId,
  groupId,
  unifiedTabId,
  isEditing
}: {
  worktreeId: string
  groupId: string
  unifiedTabId: string
  isEditing: boolean
}): WorkerTabChrome {
  const t = useTranslate()
  const tabRootRef = useRef<HTMLDivElement | null>(null)
  const stripState = useAppStore((state) =>
    selectWorkerTabStripState(state, worktreeId, groupId, unifiedTabId)
  )
  const running = useAppStore((state) => {
    if (stripState === 'none') {
      return false
    }
    const tab = indexedWorkerTab(state.unifiedTabsByWorktree[worktreeId], unifiedTabId)
    return tab ? isWorkerTabKnownRunning(state, tab) : false
  })
  const keep = useCallback(() => {
    const tab = useAppStore
      .getState()
      .unifiedTabsByWorktree[worktreeId]?.find((t) => t.id === unifiedTabId)
    if (tab) {
      keepWorkerTab(worktreeId, tab)
    }
  }, [worktreeId, unifiedTabId])
  const setTabRoot = useCallback((node: HTMLDivElement | null) => {
    tabRootRef.current = node
  }, [])
  const returnFocusTo = useCallback(() => tabRootRef.current, [])
  const isPeek = stripState === 'peek'
  const keepLabel = t('workerTabs.keep', 'Keep tab')
  return {
    titleClassName: isPeek ? 'italic' : '',
    ariaDescription: isPeek ? t('workerTabs.preview', 'Preview') : undefined,
    closeLabel:
      stripState === 'none'
        ? null
        : running
          ? t('workerTabs.hideRunning', 'Hide tab · keeps running')
          : t('workerTabs.hide', 'Hide tab'),
    keepOnDoubleClick: isPeek,
    keep,
    keepButton:
      isPeek && !isEditing ? (
        <button
          type="button"
          className="mr-0.5 flex size-4 shrink-0 items-center justify-center rounded-sm text-muted-foreground hover:bg-muted hover:text-foreground"
          aria-label={keepLabel}
          title={keepLabel}
          onPointerDown={(event) => event.stopPropagation()}
          onClick={(event) => {
            event.stopPropagation()
            keep()
          }}
        >
          <Pin className="size-3" />
        </button>
      ) : null,
    badge: (
      <CoordinatorWorkersBadge coordinatorTabId={unifiedTabId} returnFocusTo={returnFocusTo} />
    ),
    setTabRoot
  }
}
