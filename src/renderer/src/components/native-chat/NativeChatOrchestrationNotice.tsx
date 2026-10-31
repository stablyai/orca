import type { ReactNode } from 'react'
import { ChevronRight, Mail } from 'lucide-react'
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from '@/components/ui/collapsible'
import { translate } from '@/i18n/i18n'
import { NATIVE_CHAT_NOTICE_COPY } from '../../../../shared/native-chat/native-chat-notice'
import { useNativeChatDisclosure } from './native-chat-disclosure-store'

export function NativeChatOrchestrationNotice({
  messageId,
  children
}: {
  messageId: string
  children: ReactNode
}): React.JSX.Element {
  const { open, setOpen } = useNativeChatDisclosure(`orchestration-mail:${messageId}`, false)
  return (
    <Collapsible open={open} onOpenChange={setOpen}>
      <CollapsibleTrigger variant="transcript" className="group/orchestration-mail">
        <Mail aria-hidden="true" className="size-3.5 shrink-0" />
        <span className="min-w-0 truncate">
          {translate(
            'components.native-chat.notices.orchestrationMail',
            NATIVE_CHAT_NOTICE_COPY.orchestrationMail
          )}
        </span>
        <ChevronRight
          aria-hidden="true"
          className="size-3.5 shrink-0 transition-transform motion-reduce:transition-none group-data-[state=open]/orchestration-mail:rotate-90"
        />
      </CollapsibleTrigger>
      <CollapsibleContent>
        <div className="py-1">{children}</div>
      </CollapsibleContent>
    </Collapsible>
  )
}
