// A bot chat's row glyphs, the same in the Activity panel and the sidebar; never the bot's picture.
import { CalendarClock, Gauge, House, MessageSquare } from 'lucide-react'
import { AgentWorkingSpinner } from '@/components/agent/status/AgentWorkingSpinner'
import { StateIndicatorTooltip } from '@/components/agent/status/StateIndicatorTooltip'
import { useTranslate } from '@/i18n/use-translate'
import { cn } from '@/lib/class-names'
import type { BotChatOrigin, BotChatTreeChat } from '../../../../shared/bots/bot-chat-tree'
import { FeishuIcon } from '../icons/FeishuIcon'
import { GitHubIcon } from '../icons/GitHubIcon'
import { LinearIcon } from '../icons/LinearIcon'
import { usageLimitStopTip } from './BotUsageLimitMark'
import type { BotUsageLimitStop } from './use-bot-usage-limit-stops'
import { SlackIcon } from '../icons/SlackIcon'

const ORIGIN_ICONS = {
  home: House,
  'feishu-local': FeishuIcon,
  slack: SlackIcon,
  linear: LinearIcon,
  github: GitHubIcon,
  automation: CalendarClock,
  side: MessageSquare
} as const

function useChatKindLabel(origin: BotChatOrigin): string {
  const t = useTranslate()
  switch (origin) {
    case 'home':
      return t('bots.chats.home', 'Home Chat')
    case 'feishu-local':
      return t('bots.feishu.chat', 'Feishu DM')
    case 'slack':
      return t('bots.chats.kindSlack', 'Slack thread')
    case 'linear':
      return t('bots.chats.kindLinear', 'Linear issue')
    case 'github':
      return t('bots.chats.kindGithub', 'GitHub thread')
    case 'automation':
      return t('bots.chats.kindAutomation', 'Automation run')
    case 'side':
      return t('bots.chats.kindSide', 'Side chat')
  }
}

/** "Replying" or "Waiting for you" while the chat is live; null while idle. */
function useBotChatStateLabel(live: BotChatTreeChat['live']): string | null {
  const t = useTranslate()
  return live === 'replying'
    ? t('bots.chats.replyingState', 'Replying')
    : live === 'needs-you'
      ? t('bots.chats.waiting', 'Waiting for you')
      : null
}

/** A chat row's spoken name: title · kind · state, the kind skipped when the title already says it. */
export function useBotChatLabel(
  chat: Pick<BotChatTreeChat, 'origin' | 'live'>,
  title: string
): string {
  const kind = useChatKindLabel(chat.origin)
  const state = useBotChatStateLabel(chat.live)
  return [title, kind === title ? null : kind, state].filter(Boolean).join(' · ')
}

// A 1 px gap around the 7 px corner badge, which sits 3 px past the icon's edge (as BotAgentAvatar's chip).
const BADGE_CUTOUT: React.CSSProperties = {
  maskImage:
    'radial-gradient(circle at calc(100% - 0.5px) calc(100% - 0.5px), transparent 4.5px, #000 5px)'
}

/** A chat's glyph slot: its icon always, with a corner badge while live: the spinner while the bot
 *  replies there, the waiting dot while it waits on the owner. The tooltip names the kind of chat. */
export function BotChatStatusSlot({
  chat,
  className,
  iconClassName = 'size-3',
  stop = null,
  onClick
}: {
  chat: Pick<BotChatTreeChat, 'origin' | 'live'>
  className?: string
  iconClassName?: string
  /** Stopped on its usage limit while quiet: the corner shows the stopped mark. */
  stop?: BotUsageLimitStop | null
  onClick?: (event: React.MouseEvent) => void
}): React.JSX.Element {
  const t = useTranslate()
  const kind = useChatKindLabel(chat.origin)
  const liveState = useBotChatStateLabel(chat.live)
  const stopped = liveState === null && stop !== null
  const state = stopped ? usageLimitStopTip(t, stop) : liveState
  const Icon = ORIGIN_ICONS[chat.origin]
  return (
    <StateIndicatorTooltip label={state ? `${kind} · ${state}` : kind}>
      {/* The row's label carries kind and state. */}
      <span
        aria-hidden
        className={cn('relative flex size-3 shrink-0 items-center justify-center', className)}
        onClick={onClick}
      >
        <span className={cn('relative shrink-0', iconClassName)}>
          <span className="block size-full" style={state ? BADGE_CUTOUT : undefined}>
            <Icon className="block size-full text-muted-foreground" />
          </span>
          {state ? (
            <span className="absolute -right-[3px] -bottom-[3px] flex size-[7px]">
              {stopped ? (
                <Gauge className="size-[8px] stroke-[3] text-status-warning" />
              ) : chat.live === 'replying' ? (
                <AgentWorkingSpinner className="size-[7px]" />
              ) : (
                <span className="block size-[7px] rounded-full bg-agent-question" />
              )}
            </span>
          ) : null}
        </span>
      </span>
    </StateIndicatorTooltip>
  )
}
