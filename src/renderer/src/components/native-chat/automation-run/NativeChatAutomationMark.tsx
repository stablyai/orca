import { Clock, Hourglass, Play, Webhook, Zap, type LucideIcon } from 'lucide-react'
import { BotAppBrandMark } from '@/components/bots/apps/BotAppBrandLogo'
import type { AutomationRowMark } from '../../../../../shared/automations/automation-chat-row'

// Connectors draw their own logo; the rest a plain mark.
const PLAIN: Record<AutomationRowMark, LucideIcon | null> = {
  github: null,
  slack: null,
  linear: null,
  google: null,
  schedule: Clock,
  webhook: Webhook,
  deadline: Hourglass,
  manual: Play,
  event: Zap
}

/** An automation row's icon slot: the connector that starts it, else a plain mark. */
export function NativeChatAutomationMark({ mark }: { mark: AutomationRowMark }): React.JSX.Element {
  const className = 'size-3.5'
  const Icon = PLAIN[mark]
  return Icon ? <Icon className={className} /> : <BotAppBrandMark id={mark} className={className} />
}
