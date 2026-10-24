import { useState, type ReactNode } from 'react'
import { ChevronDown } from 'lucide-react'
import { cn } from '@/lib/utils'
import { Button } from '../ui/button'
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from '../ui/collapsible'
import { Input } from '../ui/input'
import { Label } from '../ui/label'
import { SelectTrigger, SelectValue } from '../ui/select'
import { Tooltip, TooltipContent, TooltipTrigger } from '../ui/tooltip'
import { translate } from '@/i18n/i18n'
import type { SourceControlActionChoiceRoute } from '../../../../shared/source-control-action-launch-preferences'

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
    <div className="min-h-[56.5px] min-w-0 space-y-2">
      <Label>{label}</Label>
      {children}
      {hint ? <p className="text-[11px] text-muted-foreground">{hint}</p> : null}
    </div>
  )
}

/** Says which launches a saved choice reaches when it is not both. */
export function sourceControlActionRouteHint(route: SourceControlActionChoiceRoute): string | null {
  return route === 'chats'
    ? translate('settings.sourceControl.actionModel.chatsOnly', 'Applies to chats only')
    : route === 'terminals'
      ? translate('settings.sourceControl.actionModel.terminalsOnly', 'Applies to terminals only')
      : null
}

/** The action's free-text arguments, appended to terminal launches only. An advanced setting: it
 *  starts collapsed while empty, and opening or closing it saves nothing. */
export function SourceControlActionExtraArgsField({
  value,
  placeholder,
  disabled,
  onChange
}: {
  value: string
  placeholder?: string
  disabled?: boolean
  onChange: (value: string) => void
}): React.JSX.Element {
  const [open, setOpen] = useState(() => value.trim() !== '')
  const label = translate('settings.sourceControl.actionModel.extraArgs', 'Extra CLI arguments')
  return (
    <Collapsible open={open} onOpenChange={setOpen} className="min-w-0">
      <CollapsibleTrigger asChild>
        <Button type="button" variant="ghost" size="xs" className="-ml-1.5">
          {label}
          <ChevronDown className={cn('transition-transform', open && 'rotate-180')} />
        </Button>
      </CollapsibleTrigger>
      <CollapsibleContent>
        <div className="mt-1 space-y-2">
          <Input
            aria-label={label}
            value={value}
            onChange={(event) => onChange(event.target.value)}
            disabled={disabled}
            placeholder={placeholder}
            spellCheck={false}
            className="h-8 font-mono text-xs disabled:cursor-not-allowed disabled:bg-muted/40"
          />
          <p className="text-[11px] text-muted-foreground">
            {sourceControlActionRouteHint('terminals')}
          </p>
        </div>
      </CollapsibleContent>
    </Collapsible>
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
    <SelectTrigger size="sm" className="h-8 w-full min-w-0" aria-label={label}>
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
