import type { ReactNode } from 'react'
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip'

export function TabHoverCard({
  children,
  title,
  icon,
  programName,
  description
}: {
  children: ReactNode
  title: string
  icon: ReactNode
  programName: string
  description?: string
}): React.JSX.Element {
  return (
    <Tooltip>
      <TooltipTrigger
        asChild
        onFocus={(event) => {
          // Nested controls own their focus hints.
          if (event.target !== event.currentTarget) {
            event.preventDefault()
          }
        }}
      >
        {children}
      </TooltipTrigger>
      <TooltipContent
        variant="tab-preview"
        showArrow={false}
        side="bottom"
        align="start"
        sideOffset={0}
        data-tab-hover-card="true"
      >
        <div className="space-y-2 text-left">
          <div className="space-y-1">
            <div className="break-words font-medium" data-tab-hover-card-title>
              {title}
            </div>
            {description && <div className="break-all text-muted-foreground">{description}</div>}
          </div>
          <div
            className="flex items-center gap-2 text-muted-foreground"
            data-tab-hover-card-program
          >
            <span className="flex size-4 shrink-0 items-center justify-center" aria-hidden>
              {icon}
            </span>
            <span className="min-w-0 break-all">{programName}</span>
          </div>
        </div>
      </TooltipContent>
    </Tooltip>
  )
}
