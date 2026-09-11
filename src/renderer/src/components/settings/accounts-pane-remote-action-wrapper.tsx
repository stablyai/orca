import type React from 'react'
import { toast } from 'sonner'
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip'

export function AccountsPaneRemoteActionWrapper({
  isRemote,
  notice,
  tooltip,
  children
}: {
  isRemote: boolean
  notice: string
  tooltip: string
  children: React.ReactNode
}): React.JSX.Element {
  if (!isRemote) {
    return <>{children}</>
  }

  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <span
          tabIndex={0}
          role="button"
          aria-label={tooltip}
          className="inline-flex rounded-sm focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring"
          onClick={() => toast.info(notice)}
          onKeyDown={(event) => {
            if (event.key === 'Enter' || event.key === ' ') {
              event.preventDefault()
              toast.info(notice)
            }
          }}
        >
          {children}
        </span>
      </TooltipTrigger>
      <TooltipContent side="top">{tooltip}</TooltipContent>
    </Tooltip>
  )
}
