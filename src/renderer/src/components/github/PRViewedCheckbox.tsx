import React from 'react'
import { Check, LoaderCircle } from 'lucide-react'
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip'
import { cn } from '@/lib/utils'
import { translate } from '@/i18n/i18n'

export function PRViewedCheckbox({
  checked,
  pending,
  filePath,
  onToggle
}: {
  checked: boolean
  pending: boolean
  filePath: string
  onToggle: () => void
}): React.JSX.Element {
  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <button
          type="button"
          role="checkbox"
          aria-checked={checked}
          aria-label={translate(
            'auto.components.GitHubItemDialog.2d89a38d9d',
            '{{value0}} {{value1}} as viewed',
            { value0: checked ? 'Unmark' : 'Mark', value1: filePath }
          )}
          disabled={pending}
          onClick={(event) => {
            event.stopPropagation()
            onToggle()
          }}
          className={cn(
            'flex h-6 shrink-0 items-center gap-1.5 rounded-md px-1.5 text-[11px] text-muted-foreground transition hover:bg-muted focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring',
            checked && 'text-foreground',
            pending && 'cursor-default opacity-60'
          )}
        >
          <span
            className={cn(
              'flex size-4 items-center justify-center rounded-sm border transition-colors',
              checked
                ? 'border-foreground bg-foreground text-background'
                : 'border-muted-foreground/50 bg-background text-transparent'
            )}
          >
            {pending ? (
              <LoaderCircle className="size-3 animate-spin text-muted-foreground" />
            ) : checked ? (
              <Check className="size-3" strokeWidth={3} />
            ) : null}
          </span>
          <span>{translate('auto.components.GitHubItemDialog.af924014f8', 'Viewed')}</span>
        </button>
      </TooltipTrigger>
      <TooltipContent side="bottom" sideOffset={4}>
        {checked
          ? translate('auto.components.GitHubItemDialog.ba8e329d92', 'Unmark viewed')
          : translate('auto.components.GitHubItemDialog.16c1abe76c', 'Mark viewed')}
      </TooltipContent>
    </Tooltip>
  )
}
