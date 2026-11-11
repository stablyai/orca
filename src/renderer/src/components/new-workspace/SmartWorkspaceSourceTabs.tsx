import React from 'react'
import { Tabs, TabsList, TabsTrigger } from '@/components/ui/tabs'
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip'
import type { WorkItemSourceSearch } from './use-work-item-source-search'

export function SmartWorkspaceSourceTabs({
  model,
  onModeChange,
  inputRef,
  tabsListRef
}: {
  model: Pick<WorkItemSourceSearch, 'mode' | 'availableModes'>
  onModeChange: (mode: WorkItemSourceSearch['mode']) => void
  inputRef?: React.RefObject<HTMLInputElement | null>
  tabsListRef?: React.RefObject<HTMLDivElement | null>
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
          className="h-7 w-full justify-start gap-3 overflow-x-auto overflow-y-hidden px-0 scrollbar-sleek"
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
            <Tooltip key={id}>
              {/* Why: TabsTrigger outermost so its data-state (active) wins over the tooltip's. */}
              <TabsTrigger
                asChild
                value={id}
                tabIndex={-1}
                // Why: icon-only tabs; the label lives in the tooltip and the accessible name.
                aria-label={label}
                data-smart-name-mode={id}
                className="flex-none px-1 text-xs"
              >
                <TooltipTrigger>
                  <Icon className="size-3.5" />
                </TooltipTrigger>
              </TabsTrigger>
              <TooltipContent side="bottom" sideOffset={6}>
                {label}
              </TooltipContent>
            </Tooltip>
          ))}
        </TabsList>
      </Tabs>
    </div>
  )
}
