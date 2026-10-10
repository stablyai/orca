import type { LucideIcon } from 'lucide-react'
import { Badge } from '@/components/ui/badge'

/** The inline chip an atomic prompt node renders as: a skill, or a referenced file. */
export function NativeChatPromptPill({
  icon: Icon,
  label,
  selected,
  ...badgeProps
}: {
  icon: LucideIcon
  label: string
  selected: boolean
  title?: string
}): React.JSX.Element {
  return (
    <Badge variant="promptPill" data-selected={selected} {...badgeProps}>
      <Icon aria-hidden="true" />
      <span className="truncate">{label}</span>
    </Badge>
  )
}
