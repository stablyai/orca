import React, { useRef, useState } from 'react'
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip'
import { HostRowIcon } from '@/components/host-row-icon'
import { isRepoHeaderActionTarget } from '../../project-header-drag-contract'
import type { ProjectHeaderHostContext } from './project-header-host-context'

export function ProjectHeaderHostLabel({
  context
}: {
  context: ProjectHeaderHostContext
}): React.JSX.Element {
  return (
    <span className="flex min-w-0 max-w-1/2 shrink-0 items-center gap-1 text-xs font-normal leading-4 text-muted-foreground">
      <HostRowIcon hostId={context.hostId} className="size-3.5 shrink-0" />
      <span className="truncate">{context.label}</span>
    </span>
  )
}

export function ProjectHeaderHostTooltip({
  context,
  label,
  children
}: {
  context: ProjectHeaderHostContext | undefined
  label: string
  children: React.JSX.Element
}): React.JSX.Element {
  return context ? (
    <ProjectHeaderIdentityTooltip context={context} label={label}>
      {children}
    </ProjectHeaderIdentityTooltip>
  ) : (
    children
  )
}

function ProjectHeaderIdentityTooltip({
  context,
  label,
  children
}: {
  context: ProjectHeaderHostContext
  label: string
  children: React.JSX.Element
}): React.JSX.Element {
  const [open, setOpen] = useState(false)
  const actionOwnsTooltip = useRef(false)
  return (
    <Tooltip
      open={open}
      onOpenChange={(nextOpen) => setOpen(nextOpen && !actionOwnsTooltip.current)}
    >
      <TooltipTrigger
        asChild
        onFocus={(event) => {
          // Nested actions keep their own tooltip.
          actionOwnsTooltip.current = event.target !== event.currentTarget
          if (actionOwnsTooltip.current) {
            setOpen(false)
            event.preventDefault()
          }
        }}
        onPointerMove={(event) => {
          const wasOverAction = actionOwnsTooltip.current
          actionOwnsTooltip.current = isRepoHeaderActionTarget(event.target, event.currentTarget)
          if (actionOwnsTooltip.current) {
            setOpen(false)
            event.preventDefault()
          } else if (wasOverAction) {
            setOpen(true)
          }
        }}
      >
        {children}
      </TooltipTrigger>
      <TooltipContent
        side="right"
        sideOffset={8}
        className="max-w-80 whitespace-normal break-words text-left"
      >
        {label} — {context.label}
        {context.detail !== context.label ? <div>{context.detail}</div> : null}
      </TooltipContent>
    </Tooltip>
  )
}
