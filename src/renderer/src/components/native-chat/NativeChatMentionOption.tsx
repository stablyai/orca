import { translate } from '@/i18n/i18n'
import { useTranslate } from '@/i18n/use-translate'
import { FilenameFirstPath } from '@/components/file-actions/file-path-cursor-tooltip'
import { FileTypeIcon } from '@/components/icons/FileTypeIcon'
import { cn } from '@/lib/class-names'
import {
  nativeChatMentionValue,
  type NativeChatRoomMention
} from './composer/native-chat-composer-types'

/** One `@` menu row: a room member (a bot), or else a workspace file. */
export function NativeChatMentionOption({
  value,
  member
}: {
  value: string
  member: NativeChatRoomMention | undefined
}): React.JSX.Element {
  const t = useTranslate()
  if (member) {
    return (
      <>
        {member.icon}
        <span
          className={cn('min-w-0 flex-1', (member.unavailable || member.dimmed) && 'opacity-50')}
        >
          <span className="block truncate">{member.name}</span>
          {member.note || member.detail || member.host ? (
            <span className="flex min-w-0 items-center gap-1.5 text-xs text-muted-foreground">
              {member.host}
              {member.note || member.detail ? (
                <span className="min-w-0 truncate">
                  {member.note ??
                    t('components.native-chat.composer.botFor', 'For: {{detail}}', {
                      detail: member.detail
                    })}
                </span>
              ) : null}
            </span>
          ) : null}
        </span>
        {member.unavailable ? (
          <span className="shrink-0 pt-0.5 text-2xs text-muted-foreground">
            {member.unavailable}
          </span>
        ) : null}
      </>
    )
  }
  return (
    <>
      <FileTypeIcon filePath={value} className="mt-0.5 size-3.5 shrink-0 text-muted-foreground" />
      <FilenameFirstPath path={value} />
    </>
  )
}

/** Matching members `@` shows but can't pick (a paused bot), after the pickable ones. */
export function NativeChatUnavailableMentions({
  room
}: {
  room: { mentions: readonly NativeChatRoomMention[]; unavailable: readonly string[] } | null
}): React.JSX.Element | null {
  if (!room) {
    return null
  }
  return (
    <>
      {room.unavailable.map((value) => (
        <div
          key={value}
          aria-disabled
          className="flex w-full items-start gap-2 px-2 py-1.5 text-sm"
        >
          <NativeChatMentionOption
            value={value}
            member={room.mentions.find((mention) => nativeChatMentionValue(mention) === value)}
          />
        </div>
      ))}
    </>
  )
}

export function nativeChatMentionEmptyText(inRoom: boolean): string {
  return inRoom
    ? translate('components.native-chat.composer.noMembers', 'No matching bots')
    : translate('components.native-chat.composer.noFiles', 'No matching files')
}
