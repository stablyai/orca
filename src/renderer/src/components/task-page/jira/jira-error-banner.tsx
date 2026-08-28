import React from 'react'
import { AlertCircle, ChevronDown, ChevronRight } from 'lucide-react'

import { Button } from '@/components/ui/button'
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from '@/components/ui/collapsible'
import type { TaskPageJiraLoadError } from '@/components/task-page-jira-load-state'
import { translate } from '@/i18n/i18n'

export function TaskPageJiraErrorBanner({
  error,
  open,
  onOpenChange
}: {
  error: TaskPageJiraLoadError
  open: boolean
  onOpenChange: (open: boolean) => void
}): React.JSX.Element {
  return (
    <Collapsible
      open={open}
      onOpenChange={onOpenChange}
      className="border-b border-border bg-destructive/10 px-4 py-3 text-sm text-destructive"
    >
      <div className="flex items-start gap-2">
        <AlertCircle className="mt-0.5 size-4 flex-none" />
        <div className="min-w-0 flex-1">
          <div className="font-medium leading-5">{error.title}</div>
          {error.details ? (
            <>
              <CollapsibleTrigger asChild>
                <Button
                  type="button"
                  variant="ghost"
                  size="xs"
                  className="-ml-1 mt-1 h-6 px-1.5 text-destructive hover:bg-destructive/10 hover:text-destructive"
                >
                  {open ? <ChevronDown className="size-3" /> : <ChevronRight className="size-3" />}
                  {translate('auto.components.TaskPage.40eaf2c27c', 'Details')}
                </Button>
              </CollapsibleTrigger>
              <CollapsibleContent>
                <div className="mt-1 rounded-md border border-destructive/20 bg-background/80 px-2 py-1.5 font-mono text-xs text-foreground">
                  {error.details}
                </div>
              </CollapsibleContent>
            </>
          ) : null}
        </div>
      </div>
    </Collapsible>
  )
}
