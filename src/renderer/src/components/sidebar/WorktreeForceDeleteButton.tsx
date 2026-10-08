import { useState } from 'react'
import { ChevronDown } from 'lucide-react'
import { toast } from 'sonner'
import { translate } from '@/i18n/i18n'
import { Button } from '../ui/button'
import { ButtonGroup } from '../ui/button-group'
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger
} from '../ui/dropdown-menu'
import { Tooltip, TooltipContent, TooltipTrigger } from '../ui/tooltip'

export function WorktreeForceDeleteButton({
  toastId,
  onForceDelete,
  onAlwaysForceDelete
}: {
  toastId: string
  onForceDelete: () => void
  onAlwaysForceDelete?: () => Promise<void>
}): React.JSX.Element {
  const [isSaving, setIsSaving] = useState(false)
  const forceDelete = (): void => {
    toast.dismiss(toastId)
    onForceDelete()
  }
  const alwaysForceDelete = async (): Promise<void> => {
    if (!onAlwaysForceDelete) {
      return
    }
    setIsSaving(true)
    try {
      await onAlwaysForceDelete()
    } catch (error) {
      setIsSaving(false)
      toast.error(
        translate('workspaceDeletion.preferenceSaveFailed', 'Could not save deletion preference'),
        { description: error instanceof Error ? error.message : String(error) }
      )
      return
    }
    forceDelete()
  }

  return (
    <DropdownMenu modal={false}>
      <ButtonGroup
        onBlur={(event) => {
          if (
            event.relatedTarget instanceof HTMLElement &&
            event.relatedTarget.closest('[data-radix-menu-content]')
          ) {
            event.stopPropagation()
          }
        }}
      >
        <Button
          type="button"
          variant="destructive"
          size="sm"
          disabled={isSaving}
          onClick={forceDelete}
        >
          {translate('auto.components.sidebar.delete.worktree.flow.2b20ce87b3', 'Force Delete')}
        </Button>
        {onAlwaysForceDelete ? (
          <DropdownMenuTrigger asChild>
            <Button
              type="button"
              variant="destructive"
              size="icon-sm"
              disabled={isSaving}
              aria-label={translate('workspaceDeletion.moreActions', 'More force delete options')}
            >
              <ChevronDown className="size-3.5" />
            </Button>
          </DropdownMenuTrigger>
        ) : null}
      </ButtonGroup>
      {onAlwaysForceDelete ? (
        <DropdownMenuContent
          align="end"
          // Sonner restores toast focus on blur; the portaled menu owns its focus.
          onFocus={(event) => event.stopPropagation()}
          onBlur={(event) => event.stopPropagation()}
        >
          <Tooltip>
            <TooltipTrigger asChild>
              <DropdownMenuItem
                variant="destructive"
                onSelect={() => {
                  void alwaysForceDelete()
                }}
              >
                {translate('workspaceDeletion.alwaysForceDelete', 'Always force delete')}
              </DropdownMenuItem>
            </TooltipTrigger>
            <TooltipContent side="left" sideOffset={8}>
              {translate(
                'workspaceDeletion.alwaysForceDeleteTooltip',
                'Applies to all future workspace deletions.'
              )}
            </TooltipContent>
          </Tooltip>
        </DropdownMenuContent>
      ) : null}
    </DropdownMenu>
  )
}
