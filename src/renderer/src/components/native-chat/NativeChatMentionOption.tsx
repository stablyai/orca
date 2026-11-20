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
    const purpose =
      member.note ??
      (member.detail
        ? t('components.native-chat.composer.botFor', 'For: {{detail}}', {
            detail: member.detail
          })
        : null)
    // One line: name, its computer's pill, then what it is for, cut short (its title has it all).
    return (
      <>
        {member.icon}
        <span
          className={cn(
            'flex min-w-0 flex-1 items-baseline gap-1.5',
            (member.unavailable || member.dimmed) && 'opacity-50'
          )}
        >
          {/* Name and pill shrink too, so a narrow row never pushes them past its text area. */}
          <span className="max-w-[60%] min-w-0 truncate">{member.name}</span>
          {member.host ? (
            <span className="flex min-w-0 self-center overflow-hidden">{member.host}</span>
          ) : null}
          {member.noteIcon ? (
            <span className="flex shrink-0 self-center">{member.noteIcon}</span>
          ) : null}
          {purpose ? (
            <span title={purpose} className="min-w-0 flex-1 truncate text-xs text-muted-foreground">
              {purpose}
            </span>
          ) : null}
        </span>
        {member.unavailable ? (
          <span className="shrink-0 text-2xs text-muted-foreground">{member.unavailable}</span>
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
          className="flex w-full items-center gap-2 px-2 py-1.5 text-sm"
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
