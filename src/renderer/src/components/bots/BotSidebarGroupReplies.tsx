import React, { useMemo } from 'react'
import { Users } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { useTranslate } from '@/i18n/use-translate'
import { selectActiveBotGroupRoomId } from '@/lib/bot-group-catalog'
import { useBotGroups } from '@/lib/bot-group-list'
import { isSameBot } from '@/lib/bot-hosts'
import { cn } from '@/lib/class-names'
import { useAppStore } from '@/store'
import type { Bot } from '../../../../shared/bot-types'
import {
  isLocalExecutionHost,
  toRuntimeExecutionHostId
} from '../../../../shared/execution-host/execution-host'
import { revealBotGroupReply } from './bot-group-reply-reveal'

export function BotSidebarGroupReplies({
  bot,
  onOpen
}: {
  bot: Bot
  onOpen: () => void
}): React.JSX.Element {
  const t = useTranslate()
  const groups = useBotGroups()
  const activeRoom = useAppStore(selectActiveBotGroupRoomId)
  const { id, hostId } = bot
  const previews = useMemo(
    () =>
      groups
        .flatMap((group) => {
          const reply = group.replyPreviews?.find((candidate) => {
            if (candidate.source === 'mail' && !isLocalExecutionHost(group.hostId)) {
              return false
            }
            return isSameBot(
              { id, hostId },
              {
                id: candidate.botId,
                hostId:
                  candidate.source === 'mail'
                    ? toRuntimeExecutionHostId(candidate.environmentId)
                    : group.hostId
              }
            )
          })
          return reply ? [{ group, reply }] : []
        })
        .sort(
          (left, right) =>
            (right.reply.at ?? Number.MIN_SAFE_INTEGER) - (left.reply.at ?? Number.MIN_SAFE_INTEGER)
        ),
    [hostId, id, groups]
  )
  return (
    <>
      {previews.map(({ group, reply }) => (
        <div
          key={group.id}
          className={cn('rounded-md', activeRoom === group.id && 'bg-sidebar-accent')}
        >
          <Button
            type="button"
            variant="ghost-inset"
            size="xs"
            data-bot-sidebar-group-reply={group.id}
            aria-label={t('bots.groups.openReply', 'Open reply in {{name}}: {{reply}}', {
              name: group.name,
              reply: reply.text
            })}
            aria-current={activeRoom === group.id ? 'true' : undefined}
            className="w-full min-w-0 justify-start text-left"
            onClick={() => void revealBotGroupReply(group, reply, onOpen)}
          >
            <Users aria-hidden className="size-3.5 text-muted-foreground" />
            <span className="min-w-0 flex-1 truncate font-normal text-muted-foreground">
              <span className="text-foreground">{group.name}</span>
              {' · '}
              {reply.text}
            </span>
          </Button>
        </div>
      ))}
    </>
  )
}
