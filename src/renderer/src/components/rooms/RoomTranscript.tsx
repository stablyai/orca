import type { RefObject } from 'react'
import { CircleAlert, Loader2, MessageSquare, RotateCcw } from 'lucide-react'
import { useTranslation } from 'react-i18next'
import { translate } from '@/i18n/i18n'
import { ScrollArea } from '@/components/ui/scroll-area'
import { Button } from '@/components/ui/button'
import { cn } from '@/lib/utils'
import { buildRoomChatSegments } from './room-chat-transcript-model'
import { RoomMemberAvatar, agentFromMemberId } from './RoomMemberAvatar'
import { RoomMessageMarkdown } from './RoomMessageMarkdown'
import type { Room, RoomLine, RoomMember } from './room-types'
import { RoomWelcomeHero } from './RoomWelcomeHero'

type TranscriptProps = {
  selected: Room
  lines: RoomLine[]
  adminName: string | null
  directMember: RoomMember | null
  workingMembers: RoomMember[]
  waitingMembers: RoomMember[]
  bottomRef: RefObject<HTMLDivElement | null>
  onQuickSend: (text: string) => void
  onSpawnBot: () => void
  onRetryMember: (memberId: string) => void
}

function memberForLine(selected: Room, memberId: string | null): RoomMember | undefined {
  return selected.members.find((member) => member.memberId === memberId)
}

/** Consecutive agent messages read as one turn, like ds_bot. */
export function RoomTranscript(props: TranscriptProps) {
  const { selected, lines } = props
  useTranslation()
  const segments = buildRoomChatSegments(lines)
  const hasAgentReply = lines.some((line) => line.memberId && line.kind !== 'failed')
  const emptyDirectChat = Boolean(props.directMember) && lines.length === 0

  return (
    <ScrollArea className="min-h-0 flex-1">
      <div className="mx-auto max-w-4xl space-y-5 p-4">
        {!hasAgentReply && !emptyDirectChat ? (
          <RoomWelcomeHero
            roomName={selected.name}
            adminName={props.adminName}
            onQuickSend={props.onQuickSend}
            onSpawnBot={props.onSpawnBot}
          />
        ) : null}
        {emptyDirectChat ? (
          <div className="rounded-2xl border border-border/60 bg-card p-6 text-center">
            <MessageSquare className="mx-auto mb-2 size-5 text-muted-foreground" />
            <h2 className="text-sm font-medium">
              {translate(
                'auto.components.rooms.page.directEmptyTitle',
                'Message {{name}} in this room',
                { name: props.directMember?.name }
              )}
            </h2>
            <p className="mx-auto mt-1 max-w-md text-xs text-muted-foreground">
              {translate(
                'auto.components.rooms.page.directEmptyHint',
                'This is a focused room conversation. Other members do not join it unless mentioned.'
              )}
            </p>
          </div>
        ) : null}
        {segments.map((segment) => {
          const member = memberForLine(selected, segment.memberId)
          const failed = segment.entries.some((entry) => entry.line.kind === 'failed')
          const retryable = failed && props.onRetryMember !== undefined
          return (
            <article
              key={segment.key}
              className={cn('flex gap-2.5', segment.isUser && 'justify-end')}
              aria-label={segment.who}
            >
              {segment.isUser ? null : (
                <RoomMemberAvatar
                  member={
                    member
                      ? { ...member, agent: agentFromMemberId(member.memberId) ?? undefined }
                      : undefined
                  }
                  fallbackName={segment.who}
                />
              )}
              <div
                className={cn(
                  'min-w-0 max-w-[82%] space-y-1.5',
                  segment.isUser && 'flex flex-col items-end'
                )}
              >
                {segment.isUser ? null : (
                  <div className="flex items-center gap-1.5 text-xs text-muted-foreground">
                    <span className="font-medium text-foreground">{segment.who}</span>
                    {member?.isAdmin ? (
                      <span className="rounded-full border border-annotation-highlight/50 bg-annotation-highlight/10 px-1.5 py-px text-2xs text-annotation-highlight dark:text-annotation-highlight">
                        {translate('auto.components.rooms.page.adminRole', 'Admin')}
                      </span>
                    ) : null}
                  </div>
                )}
                <div
                  className={cn(
                    'rounded-2xl border px-3.5 py-2.5',
                    segment.isUser
                      ? 'rounded-br-md bg-background text-foreground dark:bg-secondary dark:text-secondary-foreground'
                      : 'border-border/60 bg-card text-card-foreground',
                    failed && 'border-destructive/60'
                  )}
                >
                  {segment.entries.map(({ line }) => (
                    <RoomMessageMarkdown key={line.seq} content={line.text} />
                  ))}
                </div>
                {retryable && segment.memberId ? (
                  <Button
                    variant="outline"
                    size="xs"

                    onClick={() => props.onRetryMember(segment.memberId!)}
                  >
                    <RotateCcw className="size-3" />
                    {translate('auto.components.rooms.page.retry', 'Retry')}
                  </Button>
                ) : null}
              </div>
            </article>
          )
        })}
        {props.workingMembers.map((member) => (
          <article key={member.memberId} className="flex gap-2.5" aria-label={member.name}>
            <RoomMemberAvatar
              member={{ ...member, agent: agentFromMemberId(member.memberId) ?? undefined }}
            />
            <div className="min-w-0">
              <div className="mb-1 text-xs text-muted-foreground">{member.name}</div>
              <div className="inline-flex items-center gap-2 rounded-2xl border border-border/60 bg-card px-3.5 py-2.5 text-sm text-muted-foreground">
                <Loader2 className="size-3.5 animate-spin" />
                {translate('auto.components.rooms.page.memberWorking', 'Working…')}
              </div>
            </div>
          </article>
        ))}
        {props.waitingMembers.map((member) => (
          <article key={member.memberId} className="flex gap-2.5" aria-label={member.name}>
            <RoomMemberAvatar
              member={{ ...member, agent: agentFromMemberId(member.memberId) ?? undefined }}
            />
            <div className="min-w-0">
              <div className="mb-1 text-xs text-muted-foreground">{member.name}</div>
              <div className="inline-flex items-center gap-2 rounded-2xl border border-status-warning-border bg-status-warning-background px-3.5 py-2.5 text-sm text-status-warning">
                <CircleAlert className="size-3.5" />
                {translate('auto.components.rooms.page.memberWaiting', 'Waiting for approval…')}
              </div>
            </div>
          </article>
        ))}
        <div ref={props.bottomRef} />
      </div>
    </ScrollArea>
  )
}
