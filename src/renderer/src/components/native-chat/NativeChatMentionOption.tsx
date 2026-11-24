import { translate } from '@/i18n/i18n'
import { FilenameFirstPath } from '@/components/file-actions/file-path-cursor-tooltip'
import { FileTypeIcon, FolderIcon } from '@/components/icons/FileTypeIcon'
import { isFolderPath } from '../../../../shared/quick-open/quick-open-folder-paths'
import { cn } from '@/lib/class-names'
import type {
  NativeChatMentionHit,
  NativeChatRoomMemberMatch
} from '../../../../shared/native-chat/input/native-chat-room-mentions'
import {
  nativeChatMentionValue,
  type NativeChatRoomMention
} from './composer/native-chat-composer-types'

function Highlighted({
  text,
  hits,
  muted = false
}: {
  text: string
  hits: readonly NativeChatMentionHit[] | undefined
  /** A paused row's hit stays muted, so only pickable rows read as active. */
  muted?: boolean
}): React.JSX.Element {
  if (!hits || hits.length === 0) {
    return <>{text}</>
  }
  const parts: React.ReactNode[] = []
  let at = 0
  for (const hit of [...hits].sort((a, b) => a.start - b.start)) {
    if (hit.start < at) {
      continue
    }
    parts.push(text.slice(at, hit.start))
    parts.push(
      <strong key={hit.start} className={cn('font-semibold', !muted && 'text-foreground')}>
        {text.slice(hit.start, hit.start + hit.length)}
      </strong>
    )
    at = hit.start + hit.length
  }
  parts.push(text.slice(at))
  return <>{parts}</>
}

/** One `@` menu row: a room member (a bot) by name, or else a workspace file or folder. A paused
 *  member is muted, never faded, so its name stays readable. */
export function NativeChatMentionOption({
  value,
  member,
  match
}: {
  value: string
  member: NativeChatRoomMention | undefined
  match?: NativeChatRoomMemberMatch
}): React.JSX.Element {
  if (member) {
    const paused = Boolean(member.unavailable)
    return (
      <>
        {member.icon}
        <span
          className={cn(
            'flex min-w-0 flex-1 items-baseline gap-1.5',
            (member.unavailable || member.dimmed) && 'opacity-50'
          )}
        >
          <span className="max-w-[60%] min-w-0 truncate">
            <Highlighted text={member.name} hits={match?.nameHits} muted={paused} />
          </span>
          {member.host ? (
            <span className="flex max-w-[55%] min-w-0 shrink-0 self-center">{member.host}</span>
          ) : null}
          {member.noteIcon ? (
            <span className="flex shrink-0 self-center">{member.noteIcon}</span>
          ) : null}
          {member.note ? (
            <span
              title={member.note}
              className="min-w-0 flex-1 truncate text-xs text-muted-foreground"
            >
              {member.note}
            </span>
          ) : null}
        </span>
        {member.unavailable ? (
          <span className="shrink-0 text-2xs text-muted-foreground">{member.unavailable}</span>
        ) : null}
      </>
    )
  }
  const iconClass = 'mt-0.5 size-3.5 shrink-0 text-muted-foreground'
  return (
    <>
      {isFolderPath(value) ? (
        <FolderIcon folderPath={value.slice(0, -1)} open={false} className={iconClass} />
      ) : (
        <FileTypeIcon filePath={value} className={iconClass} />
      )}
      <FilenameFirstPath path={value} />
    </>
  )
}

/** Matching members `@` shows but can't pick (a paused bot), after the pickable ones. */
export function NativeChatUnavailableMentions({
  room
}: {
  room: {
    mentions: readonly NativeChatRoomMention[]
    unavailable: readonly string[]
    matches?: readonly NativeChatRoomMemberMatch[]
  } | null
}): React.JSX.Element | null {
  if (!room) {
    return null
  }
  return (
    <>
      {room.unavailable.map((value) => (
        <div
          key={value}
          role="option"
          aria-selected={false}
          title={nativeChatMentionTitle(value, room.mentions)}
          aria-disabled
          className="flex w-full items-center gap-2 px-2 py-1.5 text-sm"
        >
          <NativeChatMentionOption
            value={value}
            member={room.mentions.find((mention) => nativeChatMentionValue(mention) === value)}
            match={room.matches?.find((match) => match.value === value)}
          />
        </div>
      ))}
    </>
  )
}

/** A row's hover title: its full name, and what it is for, which the row itself leaves out. */
export function nativeChatMentionTitle(
  value: string,
  mentions: readonly NativeChatRoomMention[] | undefined
): string {
  const member = mentions?.find((mention) => nativeChatMentionValue(mention) === value)
  return member?.detail ? `${member.name} — ${member.detail}` : (member?.name ?? value)
}

/** The `@` menu's line when nothing matches: in a room, the query no bot matched. */
export function nativeChatMentionEmptyText(inRoom: boolean, query = ''): string {
  const trimmed = query.trim()
  if (!inRoom) {
    return translate('components.native-chat.composer.noFiles', 'No matching files')
  }
  return trimmed
    ? translate('components.native-chat.composer.noBotsMatch', 'No bots match "{{query}}"', {
        query: trimmed
      })
    : translate('components.native-chat.composer.noBots', 'No bots')
}

/** What the polite live region says about the `@` rows: pickable bots, and files when listed. */
export function nativeChatMentionCountText(bots: number, files: number | null): string {
  const botText =
    bots === 0
      ? translate('components.native-chat.composer.noBots', 'No bots')
      : translate('components.native-chat.composer.botCount', '{{count}} bots', {
          count: bots,
          defaultValue_one: '{{count}} bot'
        })
  return files
    ? `${botText}, ${translate('components.native-chat.composer.fileCount', '{{count}} files', {
        count: files,
        defaultValue_one: '{{count}} file'
      })}`
    : botText
}

export function nativeChatMentionAnnouncement(
  withFiles: boolean | undefined,
  bots: number,
  fileCount: number,
  statusText: string | null,
  pending: boolean
): string {
  return withFiles !== undefined
    ? [nativeChatMentionCountText(bots, withFiles ? fileCount : null), pending ? statusText : null]
        .filter(Boolean)
        .join('. ')
    : (statusText ?? '')
}

export function groupNativeChatMentionValues(
  files: readonly string[],
  mentions: readonly NativeChatRoomMention[] | undefined,
  agents: readonly NativeChatRoomMention[] | undefined
) {
  const botValues = new Set(mentions?.map(nativeChatMentionValue))
  const agentValues = new Set(agents?.map(nativeChatMentionValue))
  const leading = (from: number, matches: (value: string) => boolean) => {
    const end = files.findIndex((value, index) => index >= from && !matches(value))
    return (end === -1 ? files.length : end) - from
  }
  const bots = leading(0, (value) => botValues.has(value))
  const agentCount = leading(bots, (value) => agentValues.has(value))
  const listed = bots + agentCount
  return { bots, agentCount, listed }
}
