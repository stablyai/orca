import { ChevronRight } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from '@/components/ui/collapsible'
import { translate } from '@/i18n/i18n'
import type { CloseTerminalDialogTerminal } from './CloseTerminalDialog'

export function CloseTerminalGroupList({
  terminals,
  expanded,
  onExpandedChange
}: {
  terminals: CloseTerminalDialogTerminal[]
  expanded: boolean
  onExpandedChange: (expanded: boolean) => void
}): React.JSX.Element {
  return (
    <Collapsible open={expanded} onOpenChange={onExpandedChange}>
      <CollapsibleTrigger asChild>
        <Button
          type="button"
          variant="ghost"
          size="xs"
          className="group w-full min-w-0 justify-start"
        >
          <ChevronRight
            aria-hidden
            className="size-3.5 transition-transform group-data-[state=open]:rotate-90 motion-reduce:transition-none"
          />
          <span className="min-w-0 truncate">
            {expanded
              ? translate(
                  'auto.components.terminal.pane.CloseTerminalGroupList.hide_terminals',
                  'Hide running terminals'
                )
              : translate(
                  'auto.components.terminal.pane.CloseTerminalGroupList.show_terminals',
                  'Show {{count}} running terminals',
                  { count: terminals.length, defaultValue_one: 'Show {{count}} running terminal' }
                )}
          </span>
        </Button>
      </CollapsibleTrigger>
      <CollapsibleContent className="mt-1">
        <div
          role="region"
          tabIndex={0}
          aria-label={translate(
            'auto.components.terminal.pane.CloseTerminalGroupList.running_terminals',
            'Running terminals'
          )}
          className="max-h-40 overflow-y-auto rounded-md border border-border px-2 py-1 text-xs text-foreground outline-none focus-visible:ring-2 focus-visible:ring-ring scrollbar-sleek"
        >
          <ul role="list" className="space-y-1">
            {terminals.map((terminal) => (
              <li key={terminal.key} className="flex min-w-0 items-center gap-2 py-1">
                <span className="min-w-0 flex-1 truncate" title={terminal.label}>
                  {terminal.label}
                </span>
                {terminal.copyKind === 'agent' ? (
                  <span className="shrink-0 text-muted-foreground">
                    {translate(
                      'auto.components.terminal.pane.CloseTerminalGroupList.agent',
                      'Agent'
                    )}
                  </span>
                ) : null}
              </li>
            ))}
          </ul>
        </div>
      </CollapsibleContent>
    </Collapsible>
  )
}
