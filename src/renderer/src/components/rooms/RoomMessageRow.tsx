import { useCallback, useEffect, useState } from 'react'
import type React from 'react'
import { Check, Copy, CornerUpLeft, Pencil, Pin, RotateCcw, Trash2, X } from 'lucide-react'
import CommentMarkdown from '@/components/sidebar/CommentMarkdown'
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip'
import { translate } from '@/i18n/i18n'
import { roomRpc } from '@/runtime/runtime-rooms-client'
import { cn } from '@/lib/utils'
import type { RoomMessage } from '../../../../shared/rooms'
import type { RoomData } from './use-room-data'
import { showRoomActionError } from './room-action-error'
import { RoomMessageAttachments } from './RoomAttachments'
import { RoomAuthorAvatar } from './RoomAuthorAvatar'
import { RoomSettledActivityTimeline } from './RoomActivityTimeline'
import { roomFinalFadeId, settledRoomActivity } from './room-activity-timeline'
import { isRoomLoopLimitSuppression } from './room-delivery-state'
import { activeMessageDeliveries, isMessageMutable, roomMessageAudience } from './room-queue-state'
import { AgentSubagentTurnLink } from '../agent-subagents/AgentSubagentContext'

export function RoomMessageRow({
  data,
  message,
  onReply
}: {
  data: RoomData
  message: RoomMessage
  onReply: (message: RoomMessage) => void
}): React.JSX.Element | null {
  const [editing, setEditing] = useState(false)
  const [draft, setDraft] = useState(message.body)
  useEffect(() => {
    if (!editing) {
      setDraft(message.body)
    }
  }, [editing, message.body])
  const isUser = message.actorKind === 'user'
  const mutable = isMessageMutable(data, message.id)
  const audience = isUser ? roomMessageAudience(data, message.id) : null
  const failedDelivery = activeMessageDeliveries(data, message.id).find(
    (item) => item.state === 'failed'
  )
  const loopSuppressed = Object.values(data.deliveries).some(
    (item) => item.messageId === message.id && isRoomLoopLimitSuppression(item)
  )
  const pin = data.snapshot?.pins.find((item) => item.messageId === message.id)
  const participant = data.snapshot?.participants.find(
    (item) => item.id === message.senderId || item.identity === message.senderIdentity
  )
  const activity = settledRoomActivity(message.metadata)
  const [copied, setCopied] = useState(false)
  const handleCopy = useCallback(() => {
    void window.api.ui.writeClipboardText(message.body).then(() => {
      setCopied(true)
      window.setTimeout(() => setCopied(false), 1500)
    })
  }, [message.body])
  if (!message.deletedAt && !message.body.trim() && message.attachments.length === 0 && !activity) {
    return null
  }
  if (isUser) {
    return (
      <div className="group flex flex-col items-end gap-0.5 px-3 py-1">
        <div className="relative max-w-[80%]">
          <div className="absolute -top-7 right-0 flex opacity-0 transition-opacity group-hover:opacity-100 group-focus-within:opacity-100">
            <MessageAction
              type="button"
              onClick={() => onReply(message)}
              className="rounded p-1 text-muted-foreground hover:bg-accent hover:text-foreground"
              label={translate('rooms.message.reply', 'Reply')}
            >
              <CornerUpLeft className="size-3.5" />
            </MessageAction>
            {!message.deletedAt && mutable ? (
              <>
                <MessageAction
                  type="button"
                  onClick={() => setEditing(true)}
                  className="rounded p-1 text-muted-foreground hover:bg-accent hover:text-foreground"
                  label={translate('rooms.common.edit', 'Edit')}
                >
                  <Pencil className="size-3.5" />
                </MessageAction>
                <MessageAction
                  type="button"
                  onClick={() =>
                    void roomRpc(data.target, 'rooms.messages.delete', {
                      messageId: message.id
                    }).catch(showRoomActionError)
                  }
                  className="rounded p-1 text-muted-foreground hover:bg-destructive/10 hover:text-destructive"
                  label={translate('rooms.common.delete', 'Delete')}
                >
                  <Trash2 className="size-3.5" />
                </MessageAction>
              </>
            ) : null}
          </div>
          {editing ? (
            <div className="flex items-start gap-1">
              <textarea
                autoFocus
                value={draft}
                onChange={(event) => setDraft(event.target.value)}
                className="min-h-20 flex-1 resize-y rounded-md border border-border bg-background p-2 text-sm outline-none focus:ring-1 focus:ring-ring"
              />
              <button
                type="button"
                aria-label={translate('rooms.message.saveEdit', 'Save edit')}
                className="rounded p-1 text-primary hover:bg-accent"
                onClick={() => {
                  if (!draft.trim()) {
                    return
                  }
                  void roomRpc(data.target, 'rooms.messages.update', {
                    messageId: message.id,
                    body: draft.trim()
                  })
                    .then(() => setEditing(false))
                    .catch(showRoomActionError)
                }}
              >
                <Check className="size-4" />
              </button>
              <button
                type="button"
                aria-label={translate('rooms.message.cancelEdit', 'Cancel edit')}
                className="rounded p-1 text-muted-foreground hover:bg-accent"
                onClick={() => {
                  setDraft(message.body)
                  setEditing(false)
                }}
              >
                <X className="size-4" />
              </button>
            </div>
          ) : message.deletedAt ? (
            <p className="rounded-lg rounded-tr-sm bg-muted px-3.5 py-2.5 text-sm italic text-muted-foreground">
              {translate('rooms.common.messageDeleted', 'Message deleted')}
            </p>
          ) : (
            <div className="rounded-lg rounded-tr-sm bg-muted px-3.5 py-2.5 text-sm text-foreground">
              <CommentMarkdown
                content={message.body}
                variant="document"
                className="text-sm"
                allowFileUriLinks
              />
            </div>
          )}
          <RoomMessageAttachments data={data} message={message} align="end" />
          {failedDelivery ? (
            <button
              type="button"
              onClick={() =>
                void roomRpc(data.target, 'rooms.deliveries.retry', {
                  deliveryId: failedDelivery.id
                }).catch(showRoomActionError)
              }
              className="mt-1 inline-flex items-center gap-1 text-[11px] text-destructive hover:underline"
            >
              <RotateCcw className="size-3" />
              {translate('rooms.message.retryDelivery', 'Delivery failed — retry')}
            </button>
          ) : null}
          {audience || message.editedAt ? (
            <div className="flex items-center justify-end gap-1.5 text-[10px] text-muted-foreground">
              {audience ? <span>{roomMessageAudienceLabel(audience)}</span> : null}
              {message.editedAt ? <span>{translate('rooms.message.edited', 'edited')}</span> : null}
            </div>
          ) : null}
        </div>
      </div>
    )
  }

  return (
    <article
      className={cn(
        'group relative rounded-lg border border-transparent py-2 pl-12 pr-3 hover:border-border hover:bg-muted/20',
        message.kind === 'system' && 'text-muted-foreground'
      )}
    >
      <div className="absolute left-3 top-2">
        <RoomAuthorAvatar actorKind={message.actorKind} participant={participant} />
      </div>
      <div className="mb-1 flex items-center gap-2 text-xs">
        <span className="font-semibold text-foreground">@{message.senderIdentity}</span>
        <span className="text-muted-foreground">
          {new Date(message.createdAt).toLocaleTimeString([], {
            hour: '2-digit',
            minute: '2-digit'
          })}
        </span>
        <div className="ml-auto flex opacity-0 transition-opacity group-hover:opacity-100 group-focus-within:opacity-100">
          <MessageAction
            type="button"
            onClick={() => onReply(message)}
            className="rounded p-1 text-muted-foreground hover:bg-accent hover:text-foreground"
            label={translate('rooms.message.reply', 'Reply')}
          >
            <CornerUpLeft className="size-3.5" />
          </MessageAction>
          {!message.deletedAt ? (
            <MessageAction
              type="button"
              onClick={handleCopy}
              className="rounded p-1 text-muted-foreground hover:bg-accent hover:text-foreground"
              label={
                copied
                  ? translate('components.native-chat.copyMessage.copied', 'Copied')
                  : translate('components.native-chat.copyMessage.copy', 'Copy message')
              }
            >
              {copied ? <Check className="size-3.5" /> : <Copy className="size-3.5" />}
            </MessageAction>
          ) : null}
          <MessageAction
            type="button"
            onClick={() =>
              void cyclePin(data, message, pin?.status ?? null).catch(showRoomActionError)
            }
            className={cn(
              'rounded p-1 hover:bg-accent hover:text-foreground',
              pin
                ? pin.status === 'done'
                  ? 'text-muted-foreground'
                  : 'text-primary'
                : 'text-muted-foreground'
            )}
            label={
              pin
                ? pin.status === 'todo'
                  ? translate('rooms.message.markPinDone', 'Mark pin done')
                  : translate('rooms.message.unpin', 'Unpin')
                : translate('rooms.message.pin', 'Pin')
            }
          >
            <Pin className="size-3.5" />
          </MessageAction>
        </div>
      </div>
      {activity ? <RoomSettledActivityTimeline activity={activity} /> : null}
      {activity && participant ? (
        <AgentSubagentTurnLink
          sourceKey={participant.id}
          startedAt={activity.startedAt}
          completedAt={activity.completedAt}
        />
      ) : null}
      {message.deletedAt ? (
        <p className="text-sm italic text-muted-foreground">
          {translate('rooms.common.messageDeleted', 'Message deleted')}
        </p>
      ) : message.body.trim() ? (
        <CommentMarkdown
          content={message.body}
          variant="document"
          className="text-sm"
          allowFileUriLinks
          streamingFade={
            activity && message.senderId
              ? {
                  id: roomFinalFadeId(message.senderId, activity.startedAt),
                  start: false
                }
              : undefined
          }
        />
      ) : null}
      <RoomMessageAttachments data={data} message={message} />
      {failedDelivery ? (
        <button
          type="button"
          onClick={() =>
            void roomRpc(data.target, 'rooms.deliveries.retry', {
              deliveryId: failedDelivery.id
            }).catch(showRoomActionError)
          }
          className="mt-1 inline-flex items-center gap-1 text-[11px] text-destructive hover:underline"
        >
          <RotateCcw className="size-3" />
          {translate('rooms.message.retryDelivery', 'Delivery failed — retry')}
        </button>
      ) : null}
      {loopSuppressed ? (
        <p className="mt-1 text-[11px] text-muted-foreground">
          {translate(
            'rooms.message.loopPaused',
            'Agent loop paused at the room limit · send /continue to resume'
          )}
        </p>
      ) : null}
    </article>
  )
}

function roomMessageAudienceLabel(
  audience: NonNullable<ReturnType<typeof roomMessageAudience>>
): string {
  const targets = audience.identities.map((identity) => `@${identity}`).join(', ')
  switch (audience.state) {
    case 'queued':
      return translate('rooms.message.queuedFor', 'Queued for {{targets}}', { targets })
    case 'steering':
      return translate('rooms.message.steeringTo', 'Steering to {{targets}}…', { targets })
    case 'steered':
      return translate('rooms.message.steeredTo', 'Steered to {{targets}}', { targets })
    case 'paused':
      return translate('rooms.message.pausedFor', 'Paused for {{targets}}', { targets })
    case 'uncertain':
      return translate('rooms.message.uncertainFor', 'Delivery to {{targets}} is uncertain', {
        targets
      })
    case 'failed':
      return translate('rooms.message.failedFor', 'Delivery to {{targets}} failed', { targets })
    default:
      return translate('rooms.message.to', 'To {{targets}}', { targets })
  }
}

function MessageAction({
  label,
  children,
  ...props
}: React.ComponentProps<'button'> & { label: string }): React.JSX.Element {
  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <button aria-label={label} {...props}>
          {children}
        </button>
      </TooltipTrigger>
      <TooltipContent side="top" sideOffset={4}>
        {label}
      </TooltipContent>
    </Tooltip>
  )
}

async function cyclePin(
  data: RoomData,
  message: RoomMessage,
  status: 'todo' | 'done' | null
): Promise<void> {
  await (status === 'done'
    ? roomRpc(data.target, 'rooms.pins.remove', {
        roomId: message.roomId,
        messageId: message.id
      })
    : roomRpc(data.target, 'rooms.pins.set', {
        roomId: message.roomId,
        messageId: message.id,
        status: status === 'todo' ? 'done' : 'todo'
      }))
}
