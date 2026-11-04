import React from 'react'
import { cn } from '@/lib/utils'
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from '@/components/ui/tooltip'

type RichMarkdownToolbarButtonProps = {
  active: boolean
  label: string
  onClick: () => void
  children: React.ReactNode
}

export function RichMarkdownToolbarButton({
  active,
  label,
  onClick,
  children
}: RichMarkdownToolbarButtonProps): React.JSX.Element {
  return (
    <TooltipProvider>
      <Tooltip>
        <TooltipTrigger asChild>
          <button
            type="button"
            className={cn('rich-markdown-toolbar-button', active && 'is-active')}
            aria-label={label}
            onMouseDown={(event) => event.preventDefault()}
            onClick={onClick}
          >
            {children}
          </button>
        </TooltipTrigger>
        <TooltipContent side="bottom" sideOffset={4}>
          {label}
        </TooltipContent>
      </Tooltip>
    </TooltipProvider>
  )
}
