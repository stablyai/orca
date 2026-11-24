import React from 'react'
import { Button } from '@/components/ui/button'
import { DialogFooter } from '@/components/ui/dialog'
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip'
import { useTranslate } from '@/i18n/use-translate'

export function WorkspaceCleanupPickFooter({
  selectedCount,
  deleteBlocked,
  onDelete
}: {
  selectedCount: number
  /** A delete is already running, so another cannot start. */
  deleteBlocked: boolean
  onDelete: () => void
}): React.JSX.Element {
  const t = useTranslate()
  const button = (
    <Button
      variant="destructive"
      disabled={selectedCount === 0 || deleteBlocked}
      data-workspace-cleanup-bulk-delete
      onClick={onDelete}
    >
      {t('components.workspace.cleanup.footer.delete', 'Delete {{count}} workspaces', {
        count: selectedCount,
        defaultValue_one: 'Delete {{count}} workspace'
      })}
    </Button>
  )
  return (
    <DialogFooter
      variant="bar"
      className="flex-row flex-wrap items-center justify-between sm:justify-between"
    >
      <span className="text-sm text-muted-foreground">
        {t('components.workspace.cleanup.footer.selected', '{{count}} selected', {
          count: selectedCount
        })}
      </span>
      {deleteBlocked ? (
        <Tooltip>
          <TooltipTrigger asChild>
            <span tabIndex={0}>{button}</span>
          </TooltipTrigger>
          <TooltipContent side="top">
            {t(
              'components.workspace.cleanup.footer.waitForDelete',
              'Wait for the current delete to finish.'
            )}
          </TooltipContent>
        </Tooltip>
      ) : (
        button
      )}
    </DialogFooter>
  )
}
