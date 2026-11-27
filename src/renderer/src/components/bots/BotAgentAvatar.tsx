import type React from 'react'
import { AgentIcon } from '@/components/agent/icons/AgentIcon'
import type { Bot, BotAgent } from '../../../../shared/bot-types'
import { BotAvatar } from './BotAvatar'

// The badge chip plus a 1.5px gap, cut from the picture so the row's own background (hover included) shows through.
const BADGE_CUTOUT: React.CSSProperties = {
  maskImage: 'radial-gradient(circle at 13.5px 13.5px, transparent 7px, #000 7.5px)'
}

/** A bot on one of its agents: the bot's picture in a row's icon column, the agent's logo on a chip in its corner. */
export function BotAgentAvatar({ bot, agent }: { bot: Bot; agent: BotAgent }): React.JSX.Element {
  return (
    <span className="relative size-4 shrink-0">
      <BotAvatar bot={bot} className="size-4 rounded-[4px] text-3xs" style={BADGE_CUTOUT} />
      <span
        className="absolute -right-[3px] -bottom-[3px] flex size-[11px] items-center justify-center overflow-hidden rounded-full border border-foreground/20 bg-popover"
        data-agent={agent}
        aria-hidden
      >
        <AgentIcon agent={agent} size={9} className="size-[9px] text-foreground" />
      </span>
    </span>
  )
}
