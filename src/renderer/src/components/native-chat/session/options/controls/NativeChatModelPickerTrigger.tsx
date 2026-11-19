import { ChevronDown, SlidersHorizontal } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { PopoverTrigger } from '@/components/ui/popover'
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip'
import { useTranslate, type Translate } from '@/i18n/use-translate'
import { translate } from '@/i18n/i18n'

export function NativeChatModelPickerTrigger({
  triggerRef,
  ...props
}: {
  modelLabel: string
  /** The options' values, shown after the model; empty when there are none to show. */
  optionsLabel: string
  accessibleName: string
  tooltipLabel: string
  disabled: boolean
  disabledReason: string | null
  dispatched: boolean
  triggerRef: React.Ref<HTMLButtonElement>
  onKeyDown: React.KeyboardEventHandler<HTMLButtonElement>
}): React.JSX.Element {
  const t = useTranslate()
  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <PopoverTrigger asChild>
          <Button
            ref={triggerRef}
            type="button"
            variant="ghost"
            size="xs"
            aria-label={props.accessibleName}
            aria-disabled={props.disabled || undefined}
            className="max-w-64"
            onClick={(event) => {
              if (props.disabled) {
                event.preventDefault()
              }
            }}
            onKeyDown={(event) => {
              if (props.disabled) {
                if (event.key === 'Enter' || event.key === ' ' || event.key === 'ArrowDown') {
                  event.preventDefault()
                }
                return
              }
              props.onKeyDown(event)
            }}
          >
            <span data-composer-label className="flex min-w-0 items-center gap-1">
              <span className="truncate text-chat-foreground">{props.modelLabel}</span>
              {props.optionsLabel ? <span className="shrink-0">{props.optionsLabel}</span> : null}
              <ChevronDown className="size-3" />
            </span>
            <SlidersHorizontal data-composer-compact-icon className="hidden size-3.5" />
          </Button>
        </PopoverTrigger>
      </TooltipTrigger>
      <TooltipContent side="top" sideOffset={4}>
        <div className="space-y-0.5">
          <div className="line-clamp-2 max-w-64 break-words">{props.tooltipLabel}</div>
          {props.disabledReason ? <div>{props.disabledReason}</div> : null}
          {props.dispatched ? (
            <div>
              {t(
                'components.native-chat.composer.sentNotConfirmed',
                'Sent to the agent — not confirmed'
              )}
            </div>
          ) : null}
        </div>
      </TooltipContent>
    </Tooltip>
  )
}

// Keep visible value text inside the accessible name for voice control (WCAG 2.5.3).
export function nativeChatModelPillAccessibleName(
  title: string,
  value: string,
  t: Translate = translate
): string {
  return value === title
    ? title
    : t('components.native-chat.composer.pillAccessibleName', '{{value0}} {{value1}}', {
        value0: title,
        value1: value
      })
}
