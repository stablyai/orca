import type { ReactNode } from 'react'
import { ChevronRight } from 'lucide-react'
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from '@/components/ui/collapsible'
import { cn } from '@/lib/class-names'
import { useNativeChatDisclosure } from '../disclosure/native-chat-disclosure-store'

export function NativeChatBotMessageNote({
  id,
  label,
  children
}: {
  id: string
  label: string
  children: ReactNode
}): React.JSX.Element {
  const disclosure = useNativeChatDisclosure(`bot-message-note:${id}`, false)
  return (
    <Collapsible open={disclosure.open} onOpenChange={disclosure.setOpen} className="w-full">
      <div className="flex justify-center">
        <CollapsibleTrigger asChild>
          <button
            type="button"
            className="flex min-h-6 max-w-full items-center gap-1 rounded-md px-1 text-xs text-chat-foreground-faint hover:text-chat-foreground-strong focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring"
          >
            <ChevronRight
              aria-hidden
              className={cn('size-3 shrink-0', disclosure.open && 'rotate-90')}
            />
            <span className="truncate">{label}</span>
          </button>
        </CollapsibleTrigger>
      </div>
      <CollapsibleContent className="mt-2">{children}</CollapsibleContent>
    </Collapsible>
  )
}
