import { indexedWorkerTab } from './worker-tab-index'
import { EyeOff, Pin, Square, X } from 'lucide-react'
import {
  ContextMenuItem,
  ContextMenuSeparator,
  ContextMenuShortcut
} from '@/components/ui/context-menu'
import { useAppStore } from '@/store/index'
import { useTranslate } from '@/i18n/use-translate'
import { selectWorkerTabStripState } from './worker-tab-presentation'
import {
  isWorkerTabKnownRunning,
  isWorkerTabKnownFinished,
  workerTabStopRequiresHome
} from './worker-tab-run-state'
import { keepWorkerTab } from './worker-tab-hide'
import { handleWorkerTabUserClose } from './worker-tab-user-close'
import { workerTabCloseKind } from './worker-tab-view-actions'
import { requestWorkerTabClose, requestWorkerTabConfirm } from './worker-tab-confirm-request'

/** Keep tab (peek only) / Hide tab (worker-only tabs) / Stop worker (while running) / Close tab, for a stamped worker tab. */
export function WorkerTabMenuItems({
  worktreeId,
  groupId,
  unifiedTabId,
  closeShortcut
}: {
  worktreeId: string
  groupId: string
  unifiedTabId: string
  closeShortcut?: string | null
}): React.JSX.Element | null {
  const t = useTranslate()
  const stripState = useAppStore((state) =>
    selectWorkerTabStripState(state, worktreeId, groupId, unifiedTabId)
  )
  const running = useAppStore((state) => {
    const tab = indexedWorkerTab(state.unifiedTabsByWorktree[worktreeId], unifiedTabId)
    return tab ? isWorkerTabKnownRunning(state, tab) : false
  })
  const alwaysOpen = useAppStore((state) => state.workerTabsMode === 'always-open')
  // A stamp whose worker pane is gone is the user's tab; a mixed tab never hides or closes from the shortcut.
  const kind = useAppStore((state) => {
    const tab = indexedWorkerTab(state.unifiedTabsByWorktree[worktreeId], unifiedTabId)
    return tab ? workerTabCloseKind(state, tab) : 'none'
  })
  const stamped = kind !== 'none'
  const pure = kind === 'pure'
  const requiresHome = useAppStore((state) => {
    const tab = indexedWorkerTab(state.unifiedTabsByWorktree[worktreeId], unifiedTabId)
    return tab ? workerTabStopRequiresHome(tab) : false
  })
  const finished = useAppStore((state) => {
    const tab = indexedWorkerTab(state.unifiedTabsByWorktree[worktreeId], unifiedTabId)
    return tab ? isWorkerTabKnownFinished(state, tab) : false
  })
  const homeReason = t('workerTabs.remote.stopReason', 'Stop it on the computer that started it')
  const closeDisabled = requiresHome && !finished
  if (!stamped) {
    return null
  }
  const tabNow = () =>
    useAppStore.getState().unifiedTabsByWorktree[worktreeId]?.find((t) => t.id === unifiedTabId)
  return (
    <>
      <ContextMenuSeparator />
      {stripState === 'peek' ? (
        <ContextMenuItem
          onSelect={() => {
            const tab = tabNow()
            if (tab) {
              keepWorkerTab(worktreeId, tab)
            }
          }}
        >
          <Pin className="size-3.5 shrink-0" />
          {t('workerTabs.menu.keep', 'Keep tab')}
        </ContextMenuItem>
      ) : null}
      {!alwaysOpen && pure ? (
        <ContextMenuItem
          onSelect={() => {
            // Re-read now: a tab that turned mixed after the menu opened keeps its note, not a hide.
            handleWorkerTabUserClose(unifiedTabId)
          }}
        >
          <EyeOff className="size-3.5 shrink-0" />
          {t('workerTabs.menu.hide', 'Hide tab')}
          {closeShortcut ? <ContextMenuShortcut>{closeShortcut}</ContextMenuShortcut> : null}
        </ContextMenuItem>
      ) : null}
      {running || (requiresHome && !finished) ? (
        <ContextMenuItem
          disabled={requiresHome}
          aria-description={requiresHome ? homeReason : undefined}
          onSelect={() => {
            const tab = tabNow()
            if (tab) {
              requestWorkerTabConfirm({ kind: 'stop', worktreeId, tab })
            }
          }}
        >
          <Square className="size-3.5 shrink-0 fill-current" />
          {t('workerTabs.menu.stop', 'Stop worker')}
        </ContextMenuItem>
      ) : null}
      <ContextMenuItem
        disabled={closeDisabled}
        aria-description={closeDisabled ? homeReason : undefined}
        onSelect={() => {
          const tab = tabNow()
          if (tab) {
            requestWorkerTabClose(worktreeId, tab)
          }
        }}
      >
        <X className="size-3.5 shrink-0" />
        {t('workerTabs.menu.closeTab', 'Close tab')}
        {alwaysOpen && pure && closeShortcut ? (
          <ContextMenuShortcut>{closeShortcut}</ContextMenuShortcut>
        ) : null}
      </ContextMenuItem>
      {closeDisabled ? (
        <div className="max-w-64 pl-8 pr-2 pb-1 text-2xs text-muted-foreground">{homeReason}</div>
      ) : null}
    </>
  )
}
