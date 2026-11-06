import { useStore } from 'zustand'
import { Button } from '@/components/ui/button'
import { ContextMenuItem, ContextMenuSeparator } from '@/components/ui/context-menu'
import { translate } from '@/i18n/i18n'
import type { useGitCommitActionsSupport } from '@/runtime/git-commit-actions-capability'
import type { GitHistoryItem } from '../../../../../shared/git/history/git-history-types'
import type { GitGraphCommitActionsController } from './git-graph-commit-actions-controller'
import { gitGraphActionLabel, type GitGraphCommitAction } from './git-graph-commit-action-copy'

type Props = {
  item: GitHistoryItem
  controller: GitGraphCommitActionsController
  support: ReturnType<typeof useGitCommitActionsSupport>
  menu?: boolean
}
export function GitGraphCommitActionControls({ item, controller, support, menu }: Props) {
  const running = useStore(controller.view, (state) => state.running)
  const merge = item.parentIds.length > 1
  const reason =
    support.supported && merge
      ? translate('gitGraph.cannotApplyMerge', "Can't cherry-pick/revert a merge commit from here")
      : support.reason
  return (
    <>
      <div className={menu ? undefined : 'flex flex-wrap gap-1'}>
        {(['checkout', 'cherry-pick', 'revert'] as const).map((action: GitGraphCommitAction) => {
          const disabled = running || !support.supported || (merge && action !== 'checkout')
          return menu ? (
            <ContextMenuItem
              key={action}
              disabled={disabled}
              onSelect={() => controller.request(action, item)}
            >
              {gitGraphActionLabel(action)}
            </ContextMenuItem>
          ) : (
            <Button
              key={action}
              variant="outline"
              size="xs"
              disabled={disabled}
              onClick={() => controller.request(action, item)}
            >
              {gitGraphActionLabel(action)}
            </Button>
          )
        })}
      </div>
      {reason && <p className="px-2 py-1 text-xs text-muted-foreground">{reason}</p>}
      {menu && <ContextMenuSeparator />}
    </>
  )
}
export function GitGraphCommitConfirmStrip({
  controller
}: {
  controller: GitGraphCommitActionsController
}) {
  const { pending } = useStore(controller.view)
  if (!pending) {
    return null
  }
  return (
    <div
      className="space-y-2 border-b border-border bg-muted p-3 text-xs"
      onKeyDown={(event) => {
        if (event.key === 'Escape') {
          controller.cancel()
        }
      }}
    >
      <p>
        {translate('gitGraph.confirmCommitAction', '{{action}} {{commit}}?', {
          action: gitGraphActionLabel(pending.action),
          commit: pending.item.id.slice(0, 7)
        })}
      </p>
      <p className="truncate text-muted-foreground">{pending.item.subject}</p>
      <div className="flex gap-2">
        <Button size="xs" onClick={() => void controller.confirm()}>
          {gitGraphActionLabel(pending.action)}
        </Button>
        <Button size="xs" variant="ghost" onClick={controller.cancel}>
          {translate('gitGraph.cancelAction', 'Cancel')}
        </Button>
      </div>
    </div>
  )
}
