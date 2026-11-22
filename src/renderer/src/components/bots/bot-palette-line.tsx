import type React from 'react'
import { useTranslate } from '@/i18n/use-translate'
import { useBotHostOffline } from '@/lib/bot-host-views'
import { readBotHostIds, readBotHostState } from '@/lib/bot-catalog-snapshot'
import { cn } from '@/lib/class-names'
import { HighlightedText } from '@/components/worktree-jump/rows/worktree-jump-palette-row-content'
import type { Bot } from '../../../../shared/bot-types'
import type { FolderWorkspace } from '../../../../shared/folder-workspaces/folder-workspace-types'
import type { MatchRange } from '../../../../shared/palette-match/normalized-text'
import { botPurposeSnippet } from '../../../../shared/bots/bot-sidebar-search'
import { BotRowLineText, useBotRowLine } from './BotRowActivityLine'

/** Which bot servers are unreachable, as one string so a catalog rebuilds only when that changes. */
export function readOfflineHostKey(): string {
  return readBotHostIds()
    .filter((hostId) => readBotHostState(hostId) === 'offline')
    .join('\n')
}

/** A bot's palette line: offline, then waiting on you, then why it matched, then what it last did. */
export function BotPaletteLine({
  bot,
  home,
  purpose,
  purposeRanges
}: {
  bot: Bot
  home: FolderWorkspace
  purpose: string
  /** Where the query matched the purpose; null when it didn't. */
  purposeRanges: readonly MatchRange[] | null
}): React.JSX.Element | null {
  const t = useTranslate()
  const { line, now, needsYou } = useBotRowLine(bot, home)
  // Says so while its server is down, as its sidebar row does.
  const offline = useBotHostOffline(bot.hostId)
  const matchedPurpose = purposeRanges !== null && purposeRanges.length > 0 && purpose !== ''
  // Read whenever the purpose matched, even when offline or waiting shows instead.
  const matchNote = matchedPurpose ? (
    <span className="sr-only"> {t('bots.palette.matchesPurpose', 'Matches purpose.')}</span>
  ) : null
  // Offline, then waiting on you, then why it matched, then what it last did.
  const waiting = needsYou || line?.kind === 'wait' || line?.kind === 'needYouElsewhere'
  if (matchedPurpose && !offline && !waiting) {
    const snippet = botPurposeSnippet(purpose, purposeRanges)
    return (
      <>
        <HighlightedText text={snippet.text} matchRanges={snippet.ranges} />
        {matchNote}
      </>
    )
  }
  if (!line && !offline) {
    return purpose ? (
      <>
        {purpose}
        {matchNote}
      </>
    ) : null
  }
  return (
    <span className={cn(home.isUnread && !offline && 'text-foreground')}>
      <BotRowLineText line={line} now={now} disconnected={offline} />
      {matchNote}
    </span>
  )
}
