import { useState } from 'react'
import { ChevronDown, ChevronRight, Info } from 'lucide-react'
import { translate } from '@/i18n/i18n'
import { Button } from '@/components/ui/button'
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from '@/components/ui/collapsible'

/** `reason` is null when no fallback happened; '' when Jira gave no reason. */
export function TaskPageJiraTextFallbackNotice({
  reason
}: {
  reason: string | null
}): React.JSX.Element {
  // Why: screen readers announce changes inside an existing live region, not a freshly mounted one.
  return (
    <div role="status">
      {reason === null ? null : <FallbackNoticeBody key={reason} reason={reason} />}
    </div>
  )
}

function FallbackNoticeBody({ reason }: { reason: string }): React.JSX.Element {
  // Why: collapsed by default; for plain-text searches Jira's JQL reason is noise.
  const [open, setOpen] = useState(false)
  return (
    <div className="flex items-start gap-2 border-b border-border/50 bg-muted/35 px-4 py-2 text-xs text-muted-foreground">
      <Info className="mt-0.5 size-3.5 flex-none" />
      <div className="min-w-0 flex-1">
        <Collapsible open={open} onOpenChange={setOpen}>
          <p className="leading-5">
            {translate(
              'auto.components.TaskPage.jiraTextMatchesNotice',
              "Showing text matches. Jira couldn't run this search as JQL."
            )}
          </p>
          {reason ? (
            <>
              <CollapsibleTrigger asChild>
                <Button type="button" variant="ghost" size="xs" className="-ml-1 mt-0.5">
                  {open ? <ChevronDown className="size-3" /> : <ChevronRight className="size-3" />}
                  {translate('auto.components.TaskPage.40eaf2c27c', 'Details')}
                </Button>
              </CollapsibleTrigger>
              <CollapsibleContent>
                <p className="mt-1 break-words">{reason}</p>
              </CollapsibleContent>
            </>
          ) : null}
        </Collapsible>
      </div>
    </div>
  )
}
