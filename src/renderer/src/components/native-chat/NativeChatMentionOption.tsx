import { translate } from '@/i18n/i18n'
import { useTranslate } from '@/i18n/use-translate'
import { FilenameFirstPath } from '@/components/file-actions/file-path-cursor-tooltip'
import { FileTypeIcon, FolderIcon } from '@/components/icons/FileTypeIcon'
import { isFolderPath } from '../../../../shared/quick-open/quick-open-folder-paths'
import { cn } from '@/lib/class-names'
import {
  nativeChatMentionSnippet,
  type NativeChatMentionHit,
  type NativeChatRoomMemberMatch
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

// Stands in for the purpose inside the translated "For: {{detail}}" so a highlighted snippet can
// take its place while the label keeps the translation's wording and order.
const DETAIL_SLOT = '\uE000'

function MemberDetail({
  detail,
  hits,
  muted
}: {
  detail: string
  hits: readonly NativeChatMentionHit[]
  muted: boolean
}): React.JSX.Element {
  if (hits.length === 0) {
    return <>{detail}</>
  }
  const snippet = nativeChatMentionSnippet(detail, hits)
  return (
    <>
      {snippet.clipped ? '…' : null}
      <Highlighted text={snippet.text} hits={snippet.hits} muted={muted} />
    </>
  )
}

/** A purpose snippet inside its "For: …" label, so every row reads the same way. */
function ForDetail({
  label,
  children
}: {
  label: string
  children: React.ReactNode
}): React.JSX.Element {
  const slot = label.indexOf(DETAIL_SLOT)
  if (slot === -1) {
    return <>{children}</>
  }
  return (
    <>
      {label.slice(0, slot)}
      {children}
      {label.slice(slot + DETAIL_SLOT.length)}
    </>
  )
}

/** One `@` menu row: a room member (a bot) on one line with what it is for, or else a workspace
 *  file or folder. A paused member is muted, never faded, so its name stays readable. */
export function NativeChatMentionOption({
  value,
  member,
  match
}: {
  value: string
  member: NativeChatRoomMention | undefined
  match?: NativeChatRoomMemberMatch
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
    // One line: name, its computer, then what it is for, cut short (its title has it all).
    const paused = Boolean(member.unavailable)
    const detailHits = match?.detailHits ?? []
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
          {purpose ? (
            <span title={purpose} className="min-w-0 flex-1 truncate text-xs text-muted-foreground">
              {member.detail && detailHits.length > 0 ? (
                <ForDetail
                  label={
                    member.note ??
                    t('components.native-chat.composer.botFor', 'For: {{detail}}', {
                      detail: DETAIL_SLOT
                    })
                  }
                >
                  <MemberDetail detail={member.detail} hits={detailHits} muted={paused} />
                </ForDetail>
              ) : (
                purpose
              )}
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

/** The full row text for a hover title, since one-line rows truncate the name and purpose. */
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

type MentionGroup = readonly NativeChatRoomMention[] | undefined

/** The leading rows of each kind: the bots, then each group after them, in order. */
export function groupNativeChatMentionValues(
  files: readonly string[],
  mentions: MentionGroup,
  after: Record<'agents' | 'chats' | 'terminals', MentionGroup>
) {
  const leading = (from: number, group: MentionGroup) => {
    const values = new Set(group?.map(nativeChatMentionValue))
    const end = files.findIndex((value, index) => index >= from && !values.has(value))
    return end === -1 ? files.length : end
  }
  const bots = leading(0, mentions)
  let listed = bots
  const groups = Object.entries(after).flatMap(([kind, group]) => {
    const from = listed
    listed = leading(from, group)
    return listed > from ? [{ kind: kind as keyof typeof after, from, to: listed }] : []
  })
  return { bots, groups, listed }
}
