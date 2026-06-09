import { cn } from '@/lib/utils'
import CommentMarkdown from '@/components/sidebar/CommentMarkdown'
import { translate } from '@/i18n/i18n'

type DashboardAgentRowMessageProps = {
  expanded: boolean
  isInterrupted: boolean
  lastAssistantMessage: string
}

export function DashboardAgentRowMessage({
  expanded,
  isInterrupted,
  lastAssistantMessage
}: DashboardAgentRowMessageProps): React.JSX.Element | null {
  // Why: message slot is always reserved in collapsed view so the row height
  // stays fixed as assistant text arrives or clears.
  if (!isInterrupted && !lastAssistantMessage) {
    return expanded ? null : (
      <div className="mt-0.5 pl-5 text-[10px] leading-snug text-muted-foreground/70"> </div>
    )
  }

  return (
    <div className="mt-0.5 flex min-w-0 items-start gap-1.5 pl-5">
      {isInterrupted ? (
        <span
          className="shrink-0 text-[10px] leading-snug text-muted-foreground/80"
          aria-label={translate("auto.components.dashboard.DashboardAgentRowMessage.1ec01cef03", "Interrupted by user")}
        >
          {translate("auto.components.dashboard.DashboardAgentRowMessage.0a01046763", "interrupted")}</span>
      ) : null}
      {lastAssistantMessage ? (
        <CommentMarkdown
          content={lastAssistantMessage}
          // Why: animate between a clipped preview and natural height without
          // measuring markdown content in JS.
          className={cn(
            'min-w-0 flex-1 overflow-hidden text-[10px] leading-snug text-muted-foreground/80',
            'transition-[height] duration-200 ease-out [interpolate-size:allow-keywords]',
            expanded ? 'h-auto' : 'h-[1lh]',
            !expanded &&
              'truncate whitespace-nowrap [&_*]:inline [&_*]:!whitespace-nowrap [&_*]:!m-0 [&_*]:!p-0 [&_ul]:list-none [&_ol]:list-none [&_br]:hidden'
          )}
          title={!expanded ? lastAssistantMessage : undefined}
        />
      ) : null}
    </div>
  )
}
