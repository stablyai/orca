import type { ReactNode } from 'react'
import { Label } from '../../ui/label'
import { SelectTrigger, SelectValue } from '../../ui/select'
import { Tooltip, TooltipContent, TooltipTrigger } from '../../ui/tooltip'

export function SourceControlActionOptionField({
  label,
  hint,
  children
}: {
  label: ReactNode
  hint?: ReactNode
  children: ReactNode
}): React.JSX.Element {
  return (
    <div className="min-h-[56.5px] min-w-0 flex-1 basis-48 space-y-2">
      <Label variant="settings">{label}</Label>
      {children}
      {hint ? <p className="text-[11px] text-muted-foreground">{hint}</p> : null}
    </div>
  )
}

export function SourceControlActionOptionTrigger({
  label,
  disabled
}: {
  label: string
  disabled?: boolean
}): React.JSX.Element {
  const trigger = (
    <SelectTrigger size="sm" density="compact" className="h-8 w-full min-w-0" aria-label={label}>
      <SelectValue className="min-w-0 flex-1">
        <span className="min-w-0 flex-1 truncate text-left">{label}</span>
      </SelectValue>
    </SelectTrigger>
  )
  return (
    <Tooltip>
      <TooltipTrigger asChild>
        {disabled ? <span className="flex min-w-0">{trigger}</span> : trigger}
      </TooltipTrigger>
      <TooltipContent side="top" sideOffset={4}>
        {label}
      </TooltipContent>
    </Tooltip>
  )
}
