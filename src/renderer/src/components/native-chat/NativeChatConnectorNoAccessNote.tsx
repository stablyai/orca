import { useId } from 'react'
import { ChevronRight } from 'lucide-react'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { useTranslate } from '@/i18n/use-translate'
import { cn } from '@/lib/class-names'
import type { ConnectorMessageAsker } from '../../../../shared/connector-message-asker'
import { connectorNoAccessView } from '../../../../shared/connectors/connector-message-asker-view'
import { useNativeChatDisclosure } from './messages/disclosure/native-chat-disclosure-store'
import { CONNECTOR_SOURCE_ICONS } from './NativeChatConnectorAskerTag'

/** Lines from people without access that arrived with a connector message: collapsed under one
 *  note, each muted and marked, so they read as context the bot was shown, never as a request. */
export function NativeChatConnectorNoAccessNote({
  messageId,
  asker
}: {
  messageId: string
  asker: ConnectorMessageAsker
}): React.JSX.Element | null {
  const t = useTranslate()
  const disclosure = useNativeChatDisclosure(`connector-no-access:${messageId}`, false)
  const listId = useId()
  const view = connectorNoAccessView(asker, t)
  if (!view) {
    return null
  }
  const SourceIcon = CONNECTOR_SOURCE_ICONS[asker.source]
  return (
    <div className="flex max-w-[80%] flex-col items-end gap-1.5">
      <Button
        type="button"
        variant="ghost"
        size="xs"
        className="-mr-1.5"
        aria-expanded={disclosure.open}
        aria-controls={listId}
        onClick={() => disclosure.setOpen(!disclosure.open)}
      >
        {view.toggle}
        <ChevronRight
          className={cn('size-3 transition-transform', disclosure.open && 'rotate-90')}
        />
      </Button>
      {disclosure.open ? (
        <div id={listId} className="flex flex-col items-end gap-2">
          {view.lines.map((line) => (
            <div key={line.key} className="flex max-w-full flex-col items-end gap-0.5">
              <Badge variant="chatContextSender" title={line.title}>
                <span
                  aria-hidden
                  className="-ml-1.5 flex size-4 shrink-0 items-center justify-center rounded-full bg-muted text-3xs font-medium text-muted-foreground"
                >
                  {line.initials}
                </span>
                <span className="min-w-0 truncate font-medium">{line.name}</span>
                <span aria-hidden>·</span>
                {SourceIcon ? <SourceIcon className="size-3 shrink-0" /> : null}
                <span>{view.sourceName}</span>
                <span aria-hidden>·</span>
                <span>{view.noAccessLabel}</span>
              </Badge>
              <div className="max-w-full border-r-2 border-border pr-2.5 text-sm break-words whitespace-pre-wrap text-chat-foreground-faint">
                {line.text}
              </div>
            </div>
          ))}
        </div>
      ) : null}
    </div>
  )
}
