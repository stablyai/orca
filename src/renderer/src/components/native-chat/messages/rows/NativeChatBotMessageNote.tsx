import { Badge } from '@/components/ui/badge'
import { useTranslate } from '@/i18n/use-translate'
import { useContext, type ReactNode } from 'react'
import { ChevronRight } from 'lucide-react'
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from '@/components/ui/collapsible'
import { cn } from '@/lib/class-names'
import { useNativeChatDisclosure } from '../disclosure/native-chat-disclosure-store'
import { NativeChatToolRunWindowContext } from '../../tools/runs/native-chat-tool-run-window-context'

export function NativeChatBotMessageNote({
  id,
  label,
  status,
  children
}: {
  id: string
  label: string
  status?: 'answered' | 'waiting'
  children: ReactNode
}): React.JSX.Element {
  const t = useTranslate()
  const disclosure = useNativeChatDisclosure(`bot-message-note:${id}`, false)
  const { findActive } = useContext(NativeChatToolRunWindowContext)
  const open = disclosure.open || findActive
  return (
    <Collapsible open={open} onOpenChange={disclosure.setOpen} className="w-full">
      <div className="flex justify-center">
        <CollapsibleTrigger asChild>
          <button
            type="button"
            className="flex min-h-6 max-w-full items-center gap-1 rounded-md px-1 text-xs text-chat-foreground-faint hover:text-chat-foreground-strong focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring"
          >
            <ChevronRight aria-hidden className={cn('size-3 shrink-0', open && 'rotate-90')} />
            <span className="truncate">{label}</span>
            {status ? (
              <Badge variant="outline">
                {status === 'answered'
                  ? t('components.native-chat.messaging.answered', 'Answered')
                  : t('components.native-chat.messaging.waiting', 'Waiting')}
              </Badge>
            ) : null}
          </button>
        </CollapsibleTrigger>
      </div>
      <CollapsibleContent className="mt-2">{children}</CollapsibleContent>
    </Collapsible>
  )
}
