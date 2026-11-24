import {
  Activity,
  Briefcase,
  CodeXml,
  Files,
  Mail,
  MessageSquare,
  Palette,
  type LucideIcon
} from 'lucide-react'
import type { BotAppCategory } from './bot-app-catalog'

const categoryIcons = {
  coding: CodeXml,
  chat: MessageSquare,
  monitoring: Activity,
  docs: Files,
  mail: Mail,
  sales: Briefcase,
  design: Palette
} satisfies Record<BotAppCategory, LucideIcon>

export function BotAppCategoryIcon({ category }: { category: BotAppCategory }): React.JSX.Element {
  const Icon = categoryIcons[category]
  return <Icon aria-hidden="true" className="size-3.5 shrink-0" />
}
