import { useState, type MouseEvent } from 'react'
import type { WorkspaceAttachment } from '../../../../shared/worktree/types'
import type { WorktreeCardPrDisplay } from './worktree-card-pr-display'
import { workspaceAttachmentProviderLabel } from './worktree-attachment-editing'
import { Ellipsis, MonitorUp } from 'lucide-react'
import { Button } from '@/components/ui/button'
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger
} from '@/components/ui/dropdown-menu'
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip'
import { HostedReviewUnlinkMenuItem } from '@/components/HostedReviewUnlinkMenuItem'
import { translate } from '@/i18n/i18n'

export function WorktreeCardReviewActions({
  label,
  number,
  provider,
  open,
  onOpenChange,
  onOpenInOrca,
  onUnlink,
  closeHover
}: {
  label: 'PR' | 'MR'
  number: number
  provider: string
  open?: boolean
  onOpenChange: (open: boolean) => void
  onOpenInOrca?: (event: MouseEvent) => void
  onUnlink?: () => void
  closeHover: () => void
}): React.JSX.Element | null {
  const [internalOpen, setInternalOpen] = useState(false)
  const isOpen = open ?? internalOpen
  if (!onOpenInOrca && !onUnlink) {
    return null
  }
  const moreActionsLabel = translate(
    'auto.components.sidebar.WorktreeCardMeta.dbe2d18972',
    'More {{value0}} actions',
    { value0: label }
  )
  const trigger = (
    <DropdownMenuTrigger asChild>
      <Button
        type="button"
        variant="ghost"
        size="icon-xs"
        className="size-5 shrink-0"
        aria-label={moreActionsLabel}
        onClick={(event) => event.stopPropagation()}
      >
        <Ellipsis className="size-3" />
      </Button>
    </DropdownMenuTrigger>
  )
  return (
    <DropdownMenu
      modal={false}
      open={isOpen}
      onOpenChange={(next) => {
        setInternalOpen(next)
        onOpenChange(next)
      }}
    >
      {isOpen ? (
        trigger
      ) : (
        <Tooltip>
          <TooltipTrigger asChild>{trigger}</TooltipTrigger>
          <TooltipContent side="top" sideOffset={4}>
            {moreActionsLabel}
          </TooltipContent>
        </Tooltip>
      )}
      <DropdownMenuContent
        align="end"
        className="w-52"
        onClick={(event) => event.stopPropagation()}
      >
        {onOpenInOrca ? (
          <DropdownMenuItem
            onClick={(event) => {
              closeHover()
              onOpenInOrca(event)
            }}
          >
            <MonitorUp className="size-3.5" />
            {translate('auto.components.sidebar.WorktreeCardMeta.2c67730e07', 'Open in Orca')}
          </DropdownMenuItem>
        ) : null}
        {onUnlink ? (
          <HostedReviewUnlinkMenuItem
            reviewLabel={label}
            reviewIdentifier={`${label === 'MR' ? '!' : '#'}${number}`}
            providerLabel={provider}
            onSelect={() => {
              closeHover()
              onUnlink()
            }}
          />
        ) : null}
      </DropdownMenuContent>
    </DropdownMenu>
  )
}

export function WorktreeCardLinkedReviewActions({
  item,
  review,
  onOpenChange,
  onOpenInOrca,
  onUnlink,
  closeHover
}: {
  item: WorkspaceAttachment
  review: WorktreeCardPrDisplay | null
  onOpenChange: (open: boolean) => void
  onOpenInOrca?: (event: MouseEvent, review?: WorktreeCardPrDisplay) => void
  onUnlink?: (item?: WorkspaceAttachment) => void
  closeHover: () => void
}): React.JSX.Element {
  const url = item.url ?? review?.url
  const label = item.type === 'mr' ? 'MR' : 'PR'
  return (
    <WorktreeCardReviewActions
      label={label}
      number={item.number}
      provider={workspaceAttachmentProviderLabel(item)}
      onOpenChange={onOpenChange}
      onOpenInOrca={
        url && item.provider === 'github' && onOpenInOrca
          ? (event) =>
              onOpenInOrca(
                event,
                review ?? {
                  provider: 'github',
                  number: item.number,
                  title: item.title ?? '',
                  url
                }
              )
          : undefined
      }
      onUnlink={onUnlink ? () => onUnlink(item) : undefined}
      closeHover={closeHover}
    />
  )
}
