import { Badge } from '@/components/ui/badge'
import { cn } from '@/lib/utils'
import { translate } from '@/i18n/i18n'

export function SideChatTabBadge({ className }: { className?: string }): React.JSX.Element {
  return (
    <Badge variant="contextLabel" className={cn('mr-1 shrink-0', className)}>
      {translate('components.native-chat.sideChat.badge', 'btw')}
    </Badge>
  )
}
