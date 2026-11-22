import { Input } from '@/components/ui/input'
import { useId } from 'react'
import { isBranchNameValid } from '../../../../../shared/git/branch-switch-target'
import { useStore } from 'zustand'
import { Button } from '@/components/ui/button'
import { ContextMenuItem, ContextMenuSeparator } from '@/components/ui/context-menu'
import { useTranslate } from '@/i18n/use-translate'
import type { useGitCommitActionsSupport } from '@/runtime/source-control/git/git-commit-actions-capability'
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
  const t = useTranslate()
  const running = useStore(controller.view, (state) => state.running)
  const merge = item.parentIds.length > 1
  const reason =
    support.supported && merge
      ? t('gitGraph.cannotApplyMerge', "Can't cherry-pick/revert a merge commit from here")
      : support.reason
  return (
    <>
      <div className={menu ? undefined : 'flex flex-wrap gap-1'}>
        {(['checkout', 'create-branch', 'cherry-pick', 'revert'] as const).map(
          (action: GitGraphCommitAction) => {
            const disabled =
              running ||
              !support.supported ||
              (merge && (action === 'cherry-pick' || action === 'revert'))
            return menu ? (
              <ContextMenuItem
                key={action}
                disabled={disabled}
                onSelect={() => controller.request(action, item)}
              >
                {gitGraphActionLabel(action, t)}
              </ContextMenuItem>
            ) : (
              <Button
                key={action}
                variant="outline"
                size="xs"
                disabled={disabled}
                onClick={() => controller.request(action, item)}
              >
                {gitGraphActionLabel(action, t)}
              </Button>
            )
          }
        )}
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
  const t = useTranslate()
  const { pending } = useStore(controller.view)
  const branchNameErrorId = useId()
  if (!pending) {
    return null
  }
  const creating = pending.action === 'create-branch'
  const validName = isBranchNameValid(pending.name ?? '')
  const invalidName = !!pending.name && !validName
  return (
    <form
      onSubmit={(event) => {
        event.preventDefault()
        if (!creating || validName) {
          void controller.confirm()
        }
      }}
      className="space-y-2 border-b border-border bg-muted p-3 text-xs"
      onKeyDown={(event) => {
        if (event.key === 'Escape') {
          controller.cancel()
        }
      }}
    >
      <p>
        {t('gitGraph.confirmCommitAction', '{{action}} {{commit}}?', {
          action: gitGraphActionLabel(pending.action, t),
          commit: pending.branchTarget?.name ?? pending.item.id.slice(0, 7)
        })}
      </p>
      <p className="truncate text-muted-foreground">{pending.item.subject}</p>
      {creating && (
        <>
          <Input
            autoFocus
            aria-label={t('gitGraph.branchName', 'Branch name')}
            aria-invalid={invalidName}
            aria-describedby={invalidName ? branchNameErrorId : undefined}
            value={pending.name ?? ''}
            onChange={(event) => controller.setBranchName(event.target.value)}
          />
          {invalidName && (
            <p id={branchNameErrorId} role="status" className="text-xs text-muted-foreground">
              {t(
                'gitGraph.invalidBranchName',
                'This branch name is invalid. Choose a different name.'
              )}
            </p>
          )}
        </>
      )}
      <div className="flex gap-2">
        <Button size="xs" type="submit" disabled={creating && !validName}>
          {gitGraphActionLabel(pending.action, t)}
        </Button>
        <Button size="xs" type="button" variant="ghost" onClick={controller.cancel}>
          {t('gitGraph.cancelAction', 'Cancel')}
        </Button>
      </div>
    </form>
  )
}
