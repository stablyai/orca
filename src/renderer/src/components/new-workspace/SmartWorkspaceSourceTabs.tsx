import React from 'react'
import { Tabs, TabsList, TabsTrigger } from '@/components/ui/tabs'
import IssueSourceSelector, { issueSourceChipClass } from '@/components/github/IssueSourceSelector'
import type { IssueSourceSelectorProps } from '@/components/github/IssueSourceSelector'
import { cn } from '@/lib/utils'
import type { WorkItemSourceSearch } from './use-work-item-source-search'

export function SmartWorkspaceSourceTabs({
  model,
  onModeChange,
  inputRef,
  tabsListRef,
  issueSource
}: {
  model: Pick<WorkItemSourceSearch, 'mode' | 'availableModes'>
  onModeChange: (mode: WorkItemSourceSearch['mode']) => void
  inputRef?: React.RefObject<HTMLInputElement | null>
  tabsListRef?: React.RefObject<HTMLDivElement | null>
  issueSource?: Pick<
    IssueSourceSelectorProps,
    'preference' | 'origin' | 'upstream' | 'disabled' | 'onChange'
  > | null
}): React.JSX.Element {
  return (
    <div className="flex min-w-0 items-center gap-2 border-b border-border/40">
      <Tabs
        value={model.mode}
        onValueChange={(value) => {
          const mode = model.availableModes.find((item) => item.id === value)?.id
          if (mode) {
            onModeChange(mode)
          }
        }}
        className="min-w-0 flex-1 gap-0"
      >
        <TabsList
          ref={tabsListRef}
          variant="line"
          className="h-7 w-full justify-start gap-4 overflow-x-auto overflow-y-hidden px-0 scrollbar-sleek"
          onFocusCapture={(event) => {
            const previous = event.relatedTarget instanceof HTMLElement ? event.relatedTarget : null
            const list = event.currentTarget
            if (previous && previous !== inputRef?.current && !list.contains(previous)) {
              event.stopPropagation()
              inputRef?.current?.focus({ preventScroll: true })
            }
          }}
        >
          {model.availableModes.map(({ id, label, Icon }) => (
            <TabsTrigger
              key={id}
              value={id}
              tabIndex={-1}
              data-smart-name-mode={id}
              className="flex-none gap-1.5 px-0 text-xs"
            >
              <Icon className="size-3.5" />
              <span>{label}</span>
            </TabsTrigger>
          ))}
        </TabsList>
      </Tabs>
      {issueSource ? (
        <div className={cn(issueSourceChipClass, 'shrink-0')} data-composer-issue-source="true">
          <IssueSourceSelector
            preference={issueSource.preference}
            origin={issueSource.origin}
            upstream={issueSource.upstream}
            density="compact"
            // Why: compact U/O only changes issue routing, not PR routing — keep
            // "Showing issues from …" so the control does not look PR-scoped.
            disabled={issueSource.disabled}
            onChange={issueSource.onChange}
          />
        </div>
      ) : null}
    </div>
  )
}
