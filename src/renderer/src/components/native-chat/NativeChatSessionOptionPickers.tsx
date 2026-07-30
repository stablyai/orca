import { memo, useState } from 'react'
import { ChevronDown } from 'lucide-react'
import { toast } from 'sonner'
import { Button } from '@/components/ui/button'
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuRadioGroup,
  DropdownMenuRadioItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger
} from '@/components/ui/dropdown-menu'
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip'
import { translate } from '@/i18n/i18n'
import type {
  SessionOptionDescriptor,
  SessionOptionsSurface,
  SessionOptionValue
} from '../../../../shared/native-chat-session-options'
import {
  nativeChatModelPillLabel,
  nativeChatOptionsPillLabel,
  nativeChatOptionsPillTitle,
  nativeChatSessionChoiceLabel,
  nativeChatSessionOptionDisabledReason,
  nativeChatSessionOptionLabel
} from './native-chat-session-option-labels'

export type NativeChatSessionOptionPickersProps = {
  surface: SessionOptionsSurface | null
  snapshot: SessionOptionDescriptor[]
  isWorking: boolean
}

const CATEGORY_ORDER: Record<string, number> = {
  thought_level: 0,
  model_config: 1,
  mode: 2
}

function sortedOptions(snapshot: readonly SessionOptionDescriptor[]): SessionOptionDescriptor[] {
  return snapshot
    .filter((descriptor) => descriptor.category !== 'model')
    .sort((left, right) => {
      const leftOrder = CATEGORY_ORDER[left.category ?? ''] ?? 3
      const rightOrder = CATEGORY_ORDER[right.category ?? ''] ?? 3
      return leftOrder - rightOrder
    })
}

function PickerTooltipContent(props: {
  label: string
  disabledReason?: string | null
  dispatched: boolean
}): React.JSX.Element {
  return (
    <div className="space-y-0.5">
      <div>{props.disabledReason ?? props.label}</div>
      {props.dispatched ? (
        <div>
          {translate(
            'components.native-chat.composer.sentNotConfirmed',
            'Sent to the agent — not confirmed'
          )}
        </div>
      ) : null}
    </div>
  )
}

function PickerTrigger(props: {
  label: string
  tooltipLabel: string
  disabled: boolean
  disabledReason?: string | null
  dispatched: boolean
}): React.JSX.Element {
  // Why: value-only visible text must still include the category in the
  // accessible name (WCAG 2.5.3 Label in Name / voice control).
  const accessibleName =
    props.label === props.tooltipLabel
      ? props.tooltipLabel
      : translate('components.native-chat.composer.pillAccessibleName', '{{value0}} {{value1}}', {
          value0: props.tooltipLabel,
          value1: props.label
        })
  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <DropdownMenuTrigger asChild disabled={props.disabled}>
          <Button
            type="button"
            variant="ghost"
            size="xs"
            aria-label={accessibleName}
            className="max-w-48 text-muted-foreground"
          >
            <span className="truncate">{props.label}</span>
            <ChevronDown className="size-3" />
          </Button>
        </DropdownMenuTrigger>
      </TooltipTrigger>
      <TooltipContent side="top" sideOffset={4}>
        <PickerTooltipContent
          label={props.tooltipLabel}
          disabledReason={props.disabledReason}
          dispatched={props.dispatched}
        />
      </TooltipContent>
    </Tooltip>
  )
}

function ChoiceBody(props: { label: string; description?: string }): React.JSX.Element {
  return (
    <div className="min-w-0 py-0.5">
      <div>{props.label}</div>
      {props.description ? (
        <div className="text-xs font-normal text-muted-foreground">{props.description}</div>
      ) : null}
    </div>
  )
}

function DescriptorMenuRows(props: {
  descriptor: SessionOptionDescriptor
  pending: boolean
  setValue: (value: SessionOptionValue) => void
  invokeAction: () => void
}): React.JSX.Element {
  const { descriptor, pending, setValue, invokeAction } = props
  // Why: flip-only without a baseline is an action — never claim On/Off.
  if (descriptor.action?.type === 'toggle-command') {
    return (
      <DropdownMenuItem disabled={!descriptor.settable || pending} onSelect={() => invokeAction()}>
        {translate('components.native-chat.composer.toggleOption', 'Toggle {{value0}}', {
          value0: nativeChatSessionOptionLabel(descriptor).toLowerCase()
        })}
      </DropdownMenuItem>
    )
  }
  // Why: agent-picker opens the TUI; it is not a set of radio choices.
  if (descriptor.action?.type === 'agent-picker') {
    return (
      <DropdownMenuItem disabled={!descriptor.settable || pending} onSelect={() => invokeAction()}>
        {translate(
          'components.native-chat.composer.chooseInAgentPicker',
          'Choose in agent picker…'
        )}
      </DropdownMenuItem>
    )
  }
  // Why: absolute On/Off only when we have tracked truth. Unknown composed
  // booleans leave the group unselected so empty radios are not a selection.
  if (descriptor.kind.type === 'boolean') {
    const selected =
      descriptor.kind.currentValue === true
        ? 'on'
        : descriptor.kind.currentValue === false
          ? 'off'
          : undefined
    return (
      <>
        {selected === undefined ? (
          <DropdownMenuLabel className="font-normal text-muted-foreground">
            {translate(
              'components.native-chat.composer.valueUnknown',
              'Current value unknown — pick On or Off'
            )}
          </DropdownMenuLabel>
        ) : null}
        <DropdownMenuRadioGroup value={selected} onValueChange={(next) => setValue(next === 'on')}>
          <DropdownMenuRadioItem value="on" disabled={!descriptor.settable || pending}>
            {translate('components.native-chat.composer.optionValue.on', 'On')}
          </DropdownMenuRadioItem>
          <DropdownMenuRadioItem value="off" disabled={!descriptor.settable || pending}>
            {translate('components.native-chat.composer.optionValue.off', 'Off')}
          </DropdownMenuRadioItem>
        </DropdownMenuRadioGroup>
      </>
    )
  }
  return (
    <DropdownMenuRadioGroup
      value={descriptor.kind.currentValue}
      onValueChange={(value) => setValue(value)}
    >
      {descriptor.kind.choices.map((choice) => (
        <DropdownMenuRadioItem
          key={choice.value}
          value={choice.value}
          disabled={!descriptor.settable || pending}
        >
          <ChoiceBody
            label={nativeChatSessionChoiceLabel(choice)}
            description={choice.description}
          />
        </DropdownMenuRadioItem>
      ))}
    </DropdownMenuRadioGroup>
  )
}

function runSurfaceCall(
  pendingKey: string,
  setPendingId: (id: string | null) => void,
  call: () => Promise<unknown>
): void {
  setPendingId(pendingKey)
  void call()
    .catch((error) => {
      toast.error(
        translate('components.native-chat.composer.optionUpdateFailed', 'Could not update option'),
        { description: error instanceof Error ? error.message : String(error) }
      )
    })
    .finally(() => setPendingId(null))
}

function NativeChatSessionOptionPickersInner({
  surface,
  snapshot,
  isWorking
}: NativeChatSessionOptionPickersProps): React.JSX.Element | null {
  const [pendingId, setPendingId] = useState<string | null>(null)
  const model = snapshot.find((descriptor) => descriptor.category === 'model')
  const options = sortedOptions(snapshot)
  if (!surface || !model) {
    return null
  }

  const setOption = (descriptor: SessionOptionDescriptor, value: SessionOptionValue): void => {
    runSurfaceCall(descriptor.id, setPendingId, () => surface.setOption(descriptor.id, value))
  }
  const invokeAction = (descriptor: SessionOptionDescriptor): void => {
    runSurfaceCall(descriptor.id, setPendingId, () => surface.invokeAction(descriptor.id))
  }

  const modelReason = nativeChatSessionOptionDisabledReason(model.disabledReason)
  const modelTooltip = translate('components.native-chat.composer.model', 'Model')
  const optionsTooltip = nativeChatOptionsPillTitle(options)
  const optionsReason =
    options.length > 0 && options.every((descriptor) => !descriptor.settable)
      ? nativeChatSessionOptionDisabledReason(options[0]?.disabledReason)
      : null

  return (
    <div className="flex min-w-0 items-center gap-0.5">
      {options.length > 0 ? (
        <DropdownMenu>
          <PickerTrigger
            label={nativeChatOptionsPillLabel(options)}
            tooltipLabel={optionsTooltip}
            disabled={isWorking || pendingId !== null}
            disabledReason={optionsReason}
            dispatched={options.some((descriptor) => descriptor.valueSource === 'dispatched')}
          />
          <DropdownMenuContent align="start" className="w-60">
            {options.map((descriptor, index) => {
              const reason = nativeChatSessionOptionDisabledReason(descriptor.disabledReason)
              return (
                <div key={descriptor.id}>
                  {index > 0 ? <DropdownMenuSeparator /> : null}
                  <DropdownMenuLabel>{nativeChatSessionOptionLabel(descriptor)}</DropdownMenuLabel>
                  {reason && !descriptor.settable ? (
                    <DropdownMenuLabel className="font-normal">{reason}</DropdownMenuLabel>
                  ) : null}
                  <DescriptorMenuRows
                    descriptor={descriptor}
                    pending={pendingId !== null}
                    setValue={(value) => setOption(descriptor, value)}
                    invokeAction={() => invokeAction(descriptor)}
                  />
                </div>
              )
            })}
          </DropdownMenuContent>
        </DropdownMenu>
      ) : null}
      <DropdownMenu>
        <PickerTrigger
          label={nativeChatModelPillLabel(model)}
          tooltipLabel={modelTooltip}
          disabled={isWorking || pendingId !== null}
          disabledReason={modelReason}
          dispatched={model.valueSource === 'dispatched'}
        />
        <DropdownMenuContent align="start" className="w-64">
          {modelReason && !model.settable ? (
            <DropdownMenuLabel className="font-normal">{modelReason}</DropdownMenuLabel>
          ) : null}
          <DescriptorMenuRows
            descriptor={model}
            pending={pendingId !== null}
            setValue={(value) => setOption(model, value)}
            invokeAction={() => invokeAction(model)}
          />
        </DropdownMenuContent>
      </DropdownMenu>
    </div>
  )
}

export const NativeChatSessionOptionPickers = memo(NativeChatSessionOptionPickersInner)
