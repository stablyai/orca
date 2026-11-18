import { useMemo, useState } from 'react'
import { ListOrdered } from 'lucide-react'
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle
} from '@/components/ui/dialog'
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip'
import { isPairedWebClientWindow } from '@/app-shell/chrome/desktop-window-chrome'
import { useNow } from '@/hooks/use-now'
import { useTranslate } from '@/i18n/use-translate'
import { activateTabAndFocusPane } from '@/lib/workspace/tabs/activate-tab-and-focus-pane'
import { activateAndRevealWorktree } from '@/lib/workspace/activation/worktree-activation'
import { useAppStore } from '@/store/index'
import { selectWorktreesByRepo } from '@/store/workspaces/catalog/workspace-record-fields'
import { getIndexedAllWorktrees } from '@/store/slices/worktrees/listing/worktree-catalog-index'
import { parsePaneKey } from '../../../../../shared/workspace-layout/stable-pane-id'
import { STATUS_BAR_CONTEXT_MENU_EXEMPT_PROPS } from '../../status-bar/composition/status-bar-context-menu-policy'
import { navigateResourceSessionToTab } from '../../status-bar/resources/session-actions/resource-session-navigation'
import { cn } from '@/lib/class-names'
import { ZotzAgentQueueBoard } from './ZotzAgentQueueBoard'
import { formatZotzGb } from './zotz-memory-format'
import { useZotzAgentQueue } from './zotz-agent-queue-store'

/** Status bar entry for the agent queue: free memory, how many wait, and the board on click. */
export function ZotzAgentQueueStatusSegment({
  iconOnly
}: {
  iconOnly: boolean
}): React.JSX.Element | null {
  const t = useTranslate()
  const snapshot = useZotzAgentQueue()
  const [open, setOpen] = useState(false)
  const now = useNow(30_000, open)
  const worktreesByRepo = useAppStore(selectWorktreesByRepo)
  const tabsByWorktree = useAppStore((s) => s.tabsByWorktree)
  const setActiveView = useAppStore((s) => s.setActiveView)
  const names = useMemo(
    () =>
      new Map(
        getIndexedAllWorktrees(worktreesByRepo).map((worktree) => [
          worktree.id,
          worktree.displayName
        ])
      ),
    [worktreesByRepo]
  )

  if (isPairedWebClientWindow()) {
    return null
  }

  const memory = snapshot.memory
  const queued = snapshot.queued.length
  const label = memory
    ? queued > 0
      ? t('zotz.agentQueue.segment.withQueue', '{{free}} GB free · {{queued}} queued', {
          free: formatZotzGb(memory.availableBytes),
          queued
        })
      : t('zotz.agentQueue.segment.free', '{{free}} GB free', {
          free: formatZotzGb(memory.availableBytes)
        })
    : t('zotz.agentQueue.segment.idle', 'Agent queue')
  const dot =
    memory?.pressure === 'critical'
      ? 'bg-destructive'
      : memory?.pressure === 'elevated' || queued > 0
        ? 'bg-agent-question'
        : 'bg-muted-foreground/40'

  return (
    <>
      <Tooltip>
        <TooltipTrigger asChild>
          <button
            type="button"
            {...STATUS_BAR_CONTEXT_MENU_EXEMPT_PROPS}
            className="inline-flex cursor-pointer items-center gap-1 rounded px-1 py-0.5 text-muted-foreground transition-colors hover:bg-accent/70 hover:text-foreground"
            aria-label={label}
            onClick={() => setOpen(true)}
          >
            <ListOrdered className="size-3" />
            {!iconOnly ? <span className="text-[11px] font-medium">{label}</span> : null}
            <span aria-hidden className={cn('size-1.5 rounded-full', dot)} />
          </button>
        </TooltipTrigger>
        <TooltipContent side="top" sideOffset={6}>
          {t('zotz.agentQueue.segment.tooltip', 'Agent queue and memory')}
        </TooltipContent>
      </Tooltip>
      <Dialog open={open} onOpenChange={setOpen}>
        <DialogContent className="sm:max-w-5xl">
          <DialogHeader>
            <DialogTitle>{t('zotz.agentQueue.board.title', 'Agent queue')}</DialogTitle>
            <DialogDescription>
              {t(
                'zotz.agentQueue.board.description',
                'Agents start when they fit in memory; the rest wait their turn here.'
              )}
            </DialogDescription>
          </DialogHeader>
          <ZotzAgentQueueBoard
            snapshot={snapshot}
            now={now}
            workspaceName={(worktreeId) =>
              worktreeId ? (names.get(worktreeId) ?? worktreeId) : ''
            }
            onForceStart={(id) => void window.api.zotzAgentQueue.forceStart(id)}
            onCancel={(id) => void window.api.zotzAgentQueue.cancel(id)}
            onOpenPane={(paneKey) => {
              const tabId = parsePaneKey(paneKey)?.tabId
              if (!tabId) {
                return
              }
              setOpen(false)
              navigateResourceSessionToTab(tabId, paneKey, {
                tabsByWorktree,
                setActiveView,
                activateAndRevealWorktree,
                activateTabAndFocusPane
              })
            }}
          />
        </DialogContent>
      </Dialog>
    </>
  )
}
