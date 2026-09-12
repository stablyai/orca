import type React from 'react'
import { toast } from 'sonner'
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip'

export function AccountsPaneRemoteActionWrapper({
  isRemote,
  notice,
  tooltip,
  actionLabel,
  children
}: {
  isRemote: boolean
  notice: string
  tooltip: string
  actionLabel?: string
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
          aria-label={actionLabel}
          className="inline-flex rounded-sm focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring"
          onClick={() => toast.info(notice)}
          onKeyDown={(event) => {
            if (event.key === 'Enter' || event.key === ' ') {
              event.preventDefault()
              toast.info(notice)
            }
          }}
        >
          <span className="pointer-events-none" aria-hidden="true">
            {children}
          </span>
        </span>
      </TooltipTrigger>
      <TooltipContent side="top">{tooltip}</TooltipContent>
    </Tooltip>
  )
}
