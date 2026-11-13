import { ChevronsDownUp, ChevronsUpDown } from 'lucide-react'
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip'
import { useTranslate } from '@/i18n/use-translate'

export function NativeChatCollapseResponseAction({
  collapsed,
  onToggle
}: {
  collapsed: boolean
  onToggle: () => void
}): React.JSX.Element {
  const t = useTranslate()
  const label = collapsed
    ? t('components.native-chat.userMessage.expandResponse', 'Expand response')
    : t('components.native-chat.userMessage.collapseResponse', 'Collapse response')
  const Icon = collapsed ? ChevronsUpDown : ChevronsDownUp
  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <button
          type="button"
          className="flex size-6 shrink-0 items-center justify-center rounded-md text-chat-foreground-faint transition-colors hover:bg-accent hover:text-accent-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
          aria-label={label}
          aria-expanded={!collapsed}
          onClick={onToggle}
        >
          <Icon className="size-3.5" />
        </button>
      </TooltipTrigger>
      <TooltipContent side="top" sideOffset={4}>
        {label}
      </TooltipContent>
    </Tooltip>
  )
}
