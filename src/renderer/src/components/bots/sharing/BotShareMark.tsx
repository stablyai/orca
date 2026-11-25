import { Users } from 'lucide-react'
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip'
import { useTranslate } from '@/i18n/use-translate'
import {
  useSharedBotHostOf,
  useTeamSharingOffered
} from '@/runtime/hosts/shared-bot-hosts/shared-bot-host-catalog'
import type { Bot } from '../../../../../shared/bot-types'

/** "Shared by <owner>" on an agent shared with this account, "Shared with <people>" on one it shares. */
export function useBotShareLine(bot: Bot): string | null {
  const t = useTranslate()
  const sharedHost = useSharedBotHostOf(bot.hostId)
  const offered = useTeamSharingOffered()
  if (sharedHost) {
    return t('bots.share.sharedBy', 'Shared by {{name}}', { name: sharedHost.ownerName })
  }
  // The owner's list stays kept, but shows only where the cloud takes shares, as Share… does.
  const people = (offered ? (bot.shares ?? []) : []).map((share) =>
    share.kind === 'account' ? (share.name ?? share.email) : share.email
  )
  return people.length > 0
    ? t('bots.share.sharedWith', 'Shared with {{names}}', { names: people.join(', ') })
    : null
}

/** The people mark after a shared agent's name, both ways; its tooltip says who. */
export function BotShareMark({ line }: { line: string }): React.JSX.Element {
  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <span role="img" aria-label={line} className="flex shrink-0 text-muted-foreground">
          <Users className="size-3" aria-hidden />
        </span>
      </TooltipTrigger>
      <TooltipContent side="top" className="max-w-72 break-words">
        {line}
      </TooltipContent>
    </Tooltip>
  )
}

/** The hover card's line naming who shared it, or with whom. */
export function BotHoverShareLine({ line }: { line: string }): React.JSX.Element {
  return (
    <div className="mt-2.5 flex min-w-0 items-center gap-1.5 border-t border-border pt-2 text-xs leading-4 text-foreground">
      <Users className="size-3 shrink-0 text-muted-foreground" aria-hidden />
      <span className="min-w-0 truncate">{line}</span>
    </div>
  )
}
