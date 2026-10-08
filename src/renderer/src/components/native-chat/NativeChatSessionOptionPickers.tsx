import { memo, useState } from 'react'
import { ChevronDown } from 'lucide-react'
import { toast } from 'sonner'
import { Button } from '@/components/ui/button'
import { SwitchIndicator } from '@/components/ui/switch'
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
import { PopoverTrigger } from '@/components/ui/popover'
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip'
import { translate } from '@/i18n/i18n'
import { sortNativeChatSessionOptions } from '../../../../shared/native-chat-session-option-snapshot'
import {
  sessionOptionDispatchUnconfirmed,
  type SessionOptionDescriptor,
  type SessionOptionsSurface,
  type SessionOptionValue
} from '../../../../shared/native-chat-session-options'
import {
  nativeChatModelPillLabel,
  nativeChatOptionsPillLabel,
  nativeChatOptionsPillTitle,
  nativeChatSessionChoiceLabel,
  nativeChatSessionOptionDisabledReason,
  nativeChatSessionOptionLabel
} from './native-chat-session-option-labels'
import type { NativeChatOptionPickerRequest } from './native-chat-composer-types'
import { agentSessionThrownFailure } from '../../../../shared/agent-session-write-failure'
import { RuntimeRpcCallError } from '@/runtime/runtime-rpc-result'
import { agentSessionWriteFailureText } from './agent-session-write-notice-text'
import { NativeChatModelCombobox } from './NativeChatModelCombobox'
import { NativeChatSessionOptionChoiceBody } from './NativeChatSessionOptionChoiceBody'

export type NativeChatSessionOptionPickersProps = {
  surface: SessionOptionsSurface | null
  snapshot: SessionOptionDescriptor[]
  isWorking: boolean
  pickerRequest?: NativeChatOptionPickerRequest | null
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
  /** The trigger of whichever surface the pill opens. */
  Trigger: typeof DropdownMenuTrigger | typeof PopoverTrigger
  label: string
  tooltipLabel: string
  disabled: boolean
  disabledReason?: string | null
  dispatched: boolean
  onKeyDown?: React.KeyboardEventHandler<HTMLButtonElement>
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
        <props.Trigger asChild disabled={props.disabled}>
          <Button
            type="button"
            variant="ghost"
            size="xs"
            aria-label={accessibleName}
            className="max-w-48"
            onKeyDown={props.onKeyDown}
          >
            <span className="truncate">{props.label}</span>
            <ChevronDown className="size-3" />
          </Button>
        </props.Trigger>
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
  // Why one switch row and not On/Off: the option is binary, so a single control
  // carries it. The row owns the label, which is why the caller drops its header.
  if (descriptor.kind.type === 'boolean') {
    const checked = descriptor.kind.currentValue
    const label = nativeChatSessionOptionLabel(descriptor)
    return (
      <DropdownMenuItem
        role="switch"
        aria-checked={checked}
        aria-label={label}
        disabled={!descriptor.settable || pending}
        // Keep the menu open: the write is async and its result lands in this row.
        onSelect={(event) => {
          event.preventDefault()
          setValue(!checked)
        }}
        className="justify-between gap-2"
      >
        <span>{label}</span>
        <SwitchIndicator checked={checked} />
      </DropdownMenuItem>
    )
  }
  return (
    <DropdownMenuRadioGroup
      aria-label={nativeChatSessionOptionLabel(descriptor)}
      value={descriptor.kind.currentValue}
      onValueChange={(value) => setValue(value)}
    >
      {descriptor.kind.choices.map((choice) => (
        <DropdownMenuRadioItem
          key={choice.value}
          value={choice.value}
          disabled={!descriptor.settable || pending}
        >
          <NativeChatSessionOptionChoiceBody
            label={nativeChatSessionChoiceLabel(choice)}
            description={choice.description}
          />
        </DropdownMenuRadioItem>
      ))}
    </DropdownMenuRadioGroup>
  )
}

/** A host's error is words for its log, so it gets the table's; a local surface's error is
 *  already written for the person. */
function optionUpdateFailureDescription(error: unknown): string {
  if (error instanceof RuntimeRpcCallError) {
    return agentSessionWriteFailureText(agentSessionThrownFailure(error, error.code), 'option')
  }
  return error instanceof Error ? error.message : String(error)
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
        { description: optionUpdateFailureDescription(error) }
      )
    })
    .finally(() => setPendingId(null))
}

function NativeChatSessionOptionPickersInner({
  surface,
  snapshot,
  isWorking,
  pickerRequest
}: NativeChatSessionOptionPickersProps): React.JSX.Element | null {
  const [pendingId, setPendingId] = useState<string | null>(null)
  const model = snapshot.find((descriptor) => descriptor.category === 'model')
  const options = sortNativeChatSessionOptions(snapshot)
  if (!surface || !model) {
    return null
  }
  // Still listed by the host: the pill shows its value and does not open, even on request.
  const modelChoicesPending = model.choicesPending === true
  const requestedModelSequence = pickerRequest?.id === model.id ? pickerRequest.sequence : null
  const requestedOptionsSequence = options.some((descriptor) => descriptor.id === pickerRequest?.id)
    ? (pickerRequest?.sequence ?? null)
    : null

  const setOption = (descriptor: SessionOptionDescriptor, value: SessionOptionValue): void => {
    runSurfaceCall(descriptor.id, setPendingId, () => surface.setOption(descriptor.id, value))
  }
  const invokeAction = (descriptor: SessionOptionDescriptor): void => {
    runSurfaceCall(descriptor.id, setPendingId, () => surface.invokeAction(descriptor.id))
  }

  const modelReason = nativeChatSessionOptionDisabledReason(model.disabledReason)
  const modelPickerKey = `model:${requestedModelSequence ?? 'idle'}`
  // Read only when a request remounts the picker: one made while pending is spent shut.
  const modelPickerDefaultOpen = requestedModelSequence !== null && !modelChoicesPending
  const modelTrigger = {
    label: nativeChatModelPillLabel(model),
    tooltipLabel: translate('components.native-chat.composer.model', 'Model'),
    disabled: isWorking || pendingId !== null || modelChoicesPending,
    disabledReason: modelReason,
    dispatched: sessionOptionDispatchUnconfirmed(model)
  }
  const optionsTooltip = nativeChatOptionsPillTitle(options)
  const optionsReason =
    options.length > 0 && options.every((descriptor) => !descriptor.settable)
      ? nativeChatSessionOptionDisabledReason(options[0]?.disabledReason)
      : null

  return (
    <div className="flex min-w-0 items-center gap-0.5 text-chat-foreground-faint">
      {model.kind.type === 'select' && !model.action ? (
        <NativeChatModelCombobox
          key={modelPickerKey}
          defaultOpen={modelPickerDefaultOpen}
          choices={model.kind.choices}
          currentValue={model.kind.currentValue}
          readOnly={!model.settable || pendingId !== null}
          readOnlyReason={modelReason}
          onSelect={(value) => setOption(model, value)}
          renderTrigger={(onKeyDown) => (
            <PickerTrigger Trigger={PopoverTrigger} {...modelTrigger} onKeyDown={onKeyDown} />
          )}
        />
      ) : (
        <DropdownMenu key={modelPickerKey} defaultOpen={modelPickerDefaultOpen}>
          <PickerTrigger Trigger={DropdownMenuTrigger} {...modelTrigger} />
          <DropdownMenuContent align="start" side="top" collisionPadding={8} className="w-64">
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
      )}
      {options.length > 0 ? (
        <DropdownMenu
          key={`options:${requestedOptionsSequence ?? 'idle'}`}
          defaultOpen={requestedOptionsSequence !== null}
        >
          <PickerTrigger
            Trigger={DropdownMenuTrigger}
            label={nativeChatOptionsPillLabel(options)}
            tooltipLabel={optionsTooltip}
            disabled={isWorking || pendingId !== null}
            disabledReason={optionsReason}
            dispatched={options.some(sessionOptionDispatchUnconfirmed)}
          />
          <DropdownMenuContent align="start" side="top" collisionPadding={8} className="w-60">
            {options.map((descriptor, index) => {
              const reason = nativeChatSessionOptionDisabledReason(descriptor.disabledReason)
              return (
                <div key={descriptor.id}>
                  {index > 0 ? <DropdownMenuSeparator /> : null}
                  {descriptor.kind.type === 'boolean' && !descriptor.action ? null : (
                    <DropdownMenuLabel>
                      {nativeChatSessionOptionLabel(descriptor)}
                    </DropdownMenuLabel>
                  )}
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
    </div>
  )
}

export const NativeChatSessionOptionPickers = memo(NativeChatSessionOptionPickersInner)
