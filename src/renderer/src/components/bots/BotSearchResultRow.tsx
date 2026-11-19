import React, { memo } from 'react'
import { useWorktreeActivityStatus } from '@/components/sidebar/workspace-card/activity/use-worktree-activity-status'
import { WORKTREE_CARD_SURFACE_CLASS_NAME } from '@/components/sidebar/workspace-card/surface/worktree-card-surface'
import { useTranslate } from '@/i18n/use-translate'
import { useBotHostOffline } from '@/lib/bot-host-views'
import { cn } from '@/lib/class-names'
import type { Bot } from '../../../../shared/bot-types'
import type { BotGroup } from '../../../../shared/bots/bot-group'
import { botGroupFaces } from '../../../../shared/bots/bot-group-face-layout'
import { foldBotStatus } from '../../../../shared/bots/bot-row-status'
import { botGroupMemberBots } from '../../../../shared/bots/bot-sidebar-entries'
import {
  botPurposeSnippet,
  splitBotSearchText,
  type BotSearchMatch,
  type BotSearchRange
} from '../../../../shared/bots/bot-sidebar-search'
import type { FolderWorkspace } from '../../../../shared/folder-workspaces/folder-workspace-types'
import { folderWorkspaceKey } from '../../../../shared/workspace/identity/workspace-scope'
import {
  BotAvatarStatusBadge,
  botAvatarBadgeCutout,
  useBotAvatarBadgeSleeping
} from './bot-avatar-status-badge'
import { BotAvatar } from './BotAvatar'
import { BotGroupFaces } from './BotGroupFaces'

export type BotSearchEntry =
  | { kind: 'bot'; id: string; bot: Bot; home: FolderWorkspace }
  | { kind: 'group'; id: string; group: BotGroup; home: FolderWorkspace }

// Find's match color; contrast on both themes: dark text on a light tint, light text on a dim one.
const MARK_CLASS = 'rounded-[2px] bg-search-match/45 text-foreground dark:bg-search-match/25'

function Marked({
  text,
  ranges
}: {
  text: string
  ranges: readonly BotSearchRange[]
}): React.JSX.Element {
  return (
    <>
      {splitBotSearchText(text, ranges).map((part, index) =>
        part.marked ? (
          <mark key={index} className={MARK_CLASS}>
            {part.text}
          </mark>
        ) : (
          <React.Fragment key={index}>{part.text}</React.Fragment>
        )
      )}
    </>
  )
}

/** A search result: the bot's or group's picture and name, and the purpose words that matched. */
export const BotSearchResultRow = memo(function BotSearchResultRow({
  match,
  purposeLine,
  botsById,
  onSelect
}: {
  match: BotSearchMatch<BotSearchEntry>
  purposeLine: string | null
  botsById: ReadonlyMap<string, Bot>
  onSelect: (entry: BotSearchEntry) => void
}): React.JSX.Element {
  const t = useTranslate()
  const { entry, nameRanges, purpose } = match
  const name = entry.kind === 'bot' ? entry.bot.name : entry.group.name
  const paused = entry.kind === 'bot' && entry.bot.paused
  const snippet = purpose ? botPurposeSnippet(purpose.text, purpose.ranges) : null
  const detail = snippet ? <Marked text={snippet.text} ranges={snippet.ranges} /> : purposeLine
  return (
    <button
      type="button"
      data-bot-search-result={entry.id}
      className={cn(
        WORKTREE_CARD_SURFACE_CLASS_NAME,
        // shrink-0: the results scroll rather than squash rows when the split caps their height.
        'worktree-sidebar-card-hover flex w-[calc(100%-0.25rem)] shrink-0 scroll-my-0.5 items-center pt-1.25 pb-1.5 pl-1.5 text-left',
        'focus-visible:ring-2 focus-visible:ring-sidebar-ring'
      )}
      onClick={() => onSelect(entry)}
      onFocus={(event) =>
        event.currentTarget.scrollIntoView({ block: 'nearest', behavior: 'instant' })
      }
      onKeyDown={(event) => {
        if (event.nativeEvent.isComposing || event.keyCode === 229) {
          return
        }
        const direction =
          event.key === 'ArrowDown'
            ? 'nextElementSibling'
            : event.key === 'ArrowUp'
              ? 'previousElementSibling'
              : null
        if (!direction) {
          return
        }
        event.preventDefault()
        const next = event.currentTarget[direction]
        if (next instanceof HTMLButtonElement && next.hasAttribute('data-bot-search-result')) {
          next.focus()
        } else if (event.key === 'ArrowUp') {
          event.currentTarget
            .closest('[data-bot-sidebar-search]')
            ?.querySelector<HTMLInputElement>('input[type=search]')
            ?.focus()
        }
      }}
    >
      {entry.kind === 'bot' ? (
        <BotResultPicture bot={entry.bot} home={entry.home} />
      ) : (
        <span className="mr-2 shrink-0">
          <BotGroupFaces
            faces={botGroupFaces(botGroupMemberBots(entry.group, botsById), (bot) => bot.id)}
            className="size-7"
          />
        </span>
      )}
      <span className="flex min-w-0 flex-1 flex-col">
        {/* Paused reads in words and a muted color, not opacity, so its marks keep full contrast. */}
        <span
          className={cn(
            'truncate text-[13px] leading-5',
            paused ? 'text-muted-foreground' : 'text-foreground'
          )}
        >
          <Marked text={name} ranges={nameRanges} />
        </span>
        {paused || detail ? (
          <span className="truncate text-xs leading-4 text-muted-foreground">
            {paused ? t('bots.row.paused', 'Paused') : null}
            {paused && detail ? ' · ' : null}
            {detail}
          </span>
        ) : null}
      </span>
    </button>
  )
})

function BotResultPicture({ bot, home }: { bot: Bot; home: FolderWorkspace }): React.JSX.Element {
  const offline = useBotHostOffline(bot.hostId)
  const status = foldBotStatus(useWorktreeActivityStatus(folderWorkspaceKey(home.id)), bot.paused)
  const badge = {
    status: offline || status === 'inactive' ? null : status,
    isUnread: false,
    sleeping: useBotAvatarBadgeSleeping(folderWorkspaceKey(home.id), status)
  }
  return (
    <span className={cn('relative mr-2 shrink-0', (bot.paused || offline) && 'opacity-60')}>
      <BotAvatar
        bot={bot}
        className="size-7 rounded-md text-sm"
        style={botAvatarBadgeCutout(badge)}
      />
      <BotAvatarStatusBadge {...badge} />
    </span>
  )
}
