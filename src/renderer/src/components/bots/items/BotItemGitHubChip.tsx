import { useContext } from 'react'
import { useTranslate } from '@/i18n/use-translate'
import { NativeChatLinkPeek } from '@/components/native-chat/links/previews/NativeChatLinkPeek'
import { hasGitHubLinkPeek } from '@/components/native-chat/links/previews/NativeChatGitHubLinkPeek'
import { NativeChatLinkPeekContext } from '@/components/native-chat/links/previews/native-chat-link-peek-context'
import { getTaskPageGitHubWorkItemStateLabel } from '@/components/task-page/github/listing/task-page-github-work-item-status'
import type { BotItemGitHubRow } from '../../../../../shared/bots/bot-item-link-rows'
import { BotItemChipButton } from './BotItemChipButton'
import { gitHubIcon, useOpenWeb } from './BotItemLinks'
import {
  checksLabel,
  GITHUB_RETRY_KEY,
  useGitHubLinkPeekFallback
} from './bot-item-github-peek-content'

/** A PR or issue chip: the GitHub card a chat's link shows when Orca can look the item up, opening
 *  below the chip so a second line's card leaves the first line in view; the tooltip otherwise. */
export function BotItemGitHubChip({ row }: { row: BotItemGitHubRow }): React.JSX.Element {
  const t = useTranslate()
  const openWeb = useOpenWeb()
  const card = hasGitHubLinkPeek(useContext(NativeChatLinkPeekContext), row.url)
  const tip = [
    row.state
      ? getTaskPageGitHubWorkItemStateLabel({ type: row.type, state: row.state }, t)
      : t('bots.items.link.notRead', 'Not read yet'),
    checksLabel(t, row.checks),
    row.repo
  ]
    .filter(Boolean)
    .join(' · ')
  const label =
    row.title ??
    (row.type === 'pr'
      ? t('bots.items.link.pr', 'PR #{{number}}', { number: row.number })
      : t('bots.items.link.issue', 'Issue #{{number}}', {
          number: row.number
        }))
  // Until the lookup answers, and if it fails, the card says what the tooltip would have.
  const fallback = useGitHubLinkPeekFallback(label, tip)
  const chip = (
    <BotItemChipButton
      icon={gitHubIcon(row)}
      label={label}
      suffix={row.title ? `#${row.number}` : null}
      tip={tip}
      tooltip={!card}
      onClick={(event) => openWeb(row.url, event)}
    />
  )
  return card ? (
    <NativeChatLinkPeek
      href={row.url}
      side="bottom"
      githubFallback={fallback.pending}
      githubFailedFallback={fallback.failed}
      retryKey={GITHUB_RETRY_KEY}
    >
      {chip}
    </NativeChatLinkPeek>
  ) : (
    chip
  )
}
