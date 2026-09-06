import { useEffect, useState, type HTMLAttributes } from 'react'
import {
  CornerDownLeft,
  GripVertical,
  LoaderCircle,
  MoreHorizontal,
  Pencil,
  RotateCcw,
  Trash2
} from 'lucide-react'
import { CSS } from '@dnd-kit/utilities'
import { useSortable } from '@dnd-kit/sortable'
import { Button } from '@/components/ui/button'
import CommentMarkdown from '@/components/sidebar/CommentMarkdown'
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip'
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger
} from '@/components/ui/dropdown-menu'
import { translate } from '@/i18n/i18n'
import { cn } from '@/lib/utils'
import {
  NativeChatImageAttachments,
  type NativeChatImageAttachment,
  type NativeChatImageLoadContext
} from './NativeChatImageAttachments'
import { basename } from '@/lib/path'

export type QueuedMessageItem = {
  id: string
  text: string
  imagePaths?: string[]
  images?: NativeChatImageAttachment[]
  state?: 'pending' | 'submitting' | 'paused' | 'uncertain'
  error?: string
  detail?: string
  canSteer?: boolean
  dragDisabled?: boolean
  canEdit?: boolean
  canRemove?: boolean
}

export type QueuedMessageCardProps = {
  item: QueuedMessageItem
  disabled?: boolean
  dragDisabled?: boolean
  droppableDisabled?: boolean
  canSteer?: boolean
  onEdit?: (text: string) => void
  onEditInComposer?: () => void
  onRemove?: () => void
  onSteer?: () => void
  onRetry?: () => void
  imageLoadContext?: NativeChatImageLoadContext
  dragHandleProps?: HTMLAttributes<HTMLSpanElement>
  hideWhileDragging?: boolean
  className?: string
}

export function QueuedMessageCard({
  item,
  disabled,
  canSteer,
  onEdit,
  onEditInComposer,
  onRemove,
  onSteer,
  onRetry,
  imageLoadContext,
  dragHandleProps,
  className
}: QueuedMessageCardProps): React.JSX.Element {
  const [editing, setEditing] = useState(false)
  const [text, setText] = useState(item.text)
  useEffect(() => setText(item.text), [item.text])
  const save = (draft = text): void => {
    const value = draft.trim()
    if ((value || item.images?.length || item.imagePaths?.length) && value !== item.text) {
      onEdit?.(value)
    }
    setEditing(false)
  }
  const busy = disabled || item.state === 'submitting'

  return (
    <div
      className={cn(
        'group flex min-w-0 items-center justify-between gap-2 py-0.5 text-sm',
        item.state === 'paused' && 'opacity-60',
        className
      )}
    >
      <span
        className={cn(
          'relative -ms-3 flex h-4 cursor-grab touch-none items-center justify-center ps-3 text-muted-foreground/70 active:cursor-grabbing',
          busy && 'pointer-events-none opacity-50'
        )}
        aria-label={translate('components.native-chat.queue.drag', 'Reorder queued message')}
        {...dragHandleProps}
      >
        <GripVertical className="size-3.5" />
      </span>
      <div className="flex min-w-0 flex-1 items-center gap-2">
        {item.images?.length || item.imagePaths?.length ? (
          <NativeChatImageAttachments
            compact
            images={
              item.images?.slice(0, 1) ??
              item
                .imagePaths!.slice(0, 1)
                .map((path) => ({ id: path, path, fileName: basename(path) }))
            }
            loadContext={imageLoadContext}
          />
        ) : null}
        <div className="min-w-0 flex-1">
          {editing ? (
            <textarea
              autoFocus
              value={text}
              rows={2}
              className="w-full resize-none rounded border border-border bg-background px-2 py-1 text-sm outline-none focus-visible:ring-2 focus-visible:ring-ring"
              onChange={(event) => setText(event.target.value)}
              onKeyDown={(event) => {
                if (event.key === 'Escape') {
                  event.preventDefault()
                  event.currentTarget.value = item.text
                  setText(item.text)
                  setEditing(false)
                } else if (event.key === 'Enter' && !event.shiftKey) {
                  event.preventDefault()
                  event.currentTarget.blur()
                }
              }}
              onBlur={(event) => save(event.currentTarget.value)}
            />
          ) : (
            <CommentMarkdown
              content={item.text}
              className="h-4 min-w-0 truncate self-center leading-4 text-muted-foreground [&_br]:hidden [&_ol]:inline [&_ol]:m-0 [&_pre]:inline [&_pre]:m-0 [&_ul]:inline [&_ul]:m-0"
            />
          )}
          {item.detail || item.error || item.state === 'uncertain' ? (
            <p className="truncate text-[11px] leading-4 text-muted-foreground">
              {item.state === 'uncertain'
                ? translate(
                    'components.native-chat.queue.uncertain',
                    'Delivery was interrupted; review before retrying.'
                  )
                : item.error || item.detail}
            </p>
          ) : null}
        </div>
      </div>
      <div className="flex shrink-0 items-center gap-0.5">
        {item.state === 'submitting' ? (
          <LoaderCircle className="mr-1 size-3.5 animate-spin text-muted-foreground" />
        ) : null}
        {(item.state === 'paused' || item.state === 'uncertain') && onRetry ? (
          <Tooltip>
            <TooltipTrigger asChild>
              <Button
                type="button"
                variant="ghost"
                size="xs"
                aria-label={translate('components.native-chat.queue.retry', 'Retry queued message')}
                disabled={busy}
                onClick={onRetry}
              >
                <RotateCcw className="size-3.5" />
                {translate('components.native-chat.queue.retryShort', 'Retry')}
              </Button>
            </TooltipTrigger>
            <TooltipContent side="top" sideOffset={4} className="max-w-80 text-center">
              <div className="space-y-1">
                <p>
                  {translate(
                    'components.native-chat.queue.retryHint',
                    'Try sending this queued message again'
                  )}
                </p>
                <p className="text-muted-foreground">
                  {translate(
                    'components.native-chat.queue.retryRemedy',
                    'Edit or delete it if retry keeps failing'
                  )}
                </p>
              </div>
            </TooltipContent>
          </Tooltip>
        ) : null}
        {canSteer && onSteer ? (
          <Tooltip>
            <TooltipTrigger asChild>
              <Button
                type="button"
                variant="ghost"
                size="xs"
                aria-label={translate('components.native-chat.queue.steer', 'Steer now')}
                disabled={busy}
                onClick={onSteer}
              >
                <CornerDownLeft className="size-3.5" />
                {translate('components.native-chat.queue.steerShort', 'Steer')}
              </Button>
            </TooltipTrigger>
            <TooltipContent side="top" sideOffset={4}>
              {translate(
                'components.native-chat.queue.steerHint',
                'Submit without interrupting the model'
              )}
            </TooltipContent>
          </Tooltip>
        ) : null}
        {onRemove && item.canRemove !== false ? (
          <QueueAction
            label={translate('components.native-chat.queue.remove', 'Remove queued message')}
            disabled={busy}
            onClick={onRemove}
          >
            <Trash2 className="size-3.5" />
          </QueueAction>
        ) : null}
        {item.canEdit !== false && (onEdit || onEditInComposer) ? (
          <DropdownMenu modal={false}>
            <DropdownMenuTrigger asChild>
              <Button
                type="button"
                variant="ghost"
                size="icon-xs"
                disabled={busy}
                aria-label={translate('components.native-chat.queue.more', 'More actions')}
              >
                <MoreHorizontal className="size-3.5" />
              </Button>
            </DropdownMenuTrigger>
            <DropdownMenuContent align="end" className="min-w-32">
              <DropdownMenuItem
                onSelect={() => (onEditInComposer ? onEditInComposer() : setEditing(true))}
              >
                <Pencil />
                {translate('components.native-chat.queue.edit', 'Edit')}
              </DropdownMenuItem>
            </DropdownMenuContent>
          </DropdownMenu>
        ) : null}
      </div>
    </div>
  )
}

function QueueAction({
  label,
  disabled,
  onClick,
  children
}: {
  label: string
  disabled: boolean
  onClick: () => void
  children: React.ReactNode
}): React.JSX.Element {
  return (
    <Button
      type="button"
      variant="ghost"
      size="icon-xs"
      disabled={disabled}
      aria-label={label}
      onClick={onClick}
    >
      {children}
    </Button>
  )
}

export function SortableQueuedMessageCard(props: QueuedMessageCardProps): React.JSX.Element {
  const sortable = useSortable({
    id: props.item.id,
    disabled: {
      draggable: props.dragDisabled ?? props.disabled,
      droppable: props.droppableDisabled
    },
    data: { item: props.item }
  })
  return (
    <div
      ref={sortable.setNodeRef}
      inert={sortable.isDragging || undefined}
      style={{
        transform: CSS.Transform.toString(sortable.transform),
        transition: sortable.transition,
        opacity: sortable.isDragging ? (props.hideWhileDragging ? 0 : 0.55) : 1
      }}
    >
      <QueuedMessageCard
        {...props}
        dragHandleProps={{ ...sortable.attributes, ...sortable.listeners }}
      />
    </div>
  )
}
