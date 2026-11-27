import type { ElementType } from 'react'
import { GitPullRequest, MessageSquare, SquarePen } from 'lucide-react'
import type { BotAccessConnector } from '../../../../shared/bots/bot-access-reach'

/** The icon on a connector's reach line in a bot's access summary. */
export const CONNECTOR_ICON: Record<BotAccessConnector, ElementType> = {
  linear: SquarePen,
  slack: MessageSquare,
  cliq: MessageSquare,
  github: GitPullRequest
}
