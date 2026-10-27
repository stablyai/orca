import { memo, useEffect, useRef, useState } from 'react'
import { ChevronDown } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover'
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip'
import { translate } from '@/i18n/i18n'
import { sortNativeChatSessionOptions } from '../../../../shared/native-chat/input/native-chat-session-option-snapshot'
import {
  sessionOptionDispatchUnconfirmed,
  type SessionOptionDescriptor,
  type SessionOptionsSurface,
  type SessionOptionValue
} from '../../../../shared/native-chat/input/native-chat-session-options'
import {
  nativeChatModelPillLabel,
  nativeChatOptionValuesLabel,
  nativeChatOptionsPillTitle,
  nativeChatSessionOptionActionLabel,
  nativeChatSessionOptionDisabledReason
} from './native-chat-session-option-labels'
import type { NativeChatOptionPickerRequest } from './native-chat-composer-types'
import { runSessionOptionSurfaceCall } from './native-chat-session-option-surface-call'
import { NativeChatModelCombobox } from './NativeChatModelCombobox'
import { useNativeChatPickerFocusReturn } from './native-chat-picker-focus-return'
import { NativeChatSessionOptionRows } from './NativeChatSessionOptionRows'
import { NativeChatSessionOptionWriteGroup } from './NativeChatSessionOptionWriteGroup'

export type NativeChatSessionOptionPickersProps = {
  surface: SessionOptionsSurface | null
  snapshot: SessionOptionDescriptor[]
  isWorking: boolean
  pickerRequest?: NativeChatOptionPickerRequest | null
  /** Where focus lands after a visit that changed something; see `useNativeChatPickerFocusReturn`. */
  focusComposer?: () => void
}

/** A descriptor write in flight; its value shows until it settles. */
type PendingPick = { id: string; value?: SessionOptionValue }

// Show pending picks in place while open; refusal restores the host snapshot.
function withPendingValue(
  descriptor: SessionOptionDescriptor,
  pending: PendingPick | null
): SessionOptionDescriptor {
  if (pending?.id !== descriptor.id) {
    return descriptor
  }
  const { kind } = descriptor
  if (kind.type === 'select' && typeof pending.value === 'string') {
    return {
      ...descriptor,
      valueSource: 'dispatched',
      kind: { ...kind, currentValue: pending.value }
    }
  }
  if (kind.type === 'boolean' && typeof pending.value === 'boolean') {
    return {
      ...descriptor,
      valueSource: 'dispatched',
      kind: { ...kind, currentValue: pending.value }
    }
  }
  return descriptor
}

// Keep visible value text inside the accessible name for voice control (WCAG 2.5.3).
function pillAccessibleName(title: string, value: string): string {
  return value === title
    ? title
    : translate('components.native-chat.composer.pillAccessibleName', '{{value0}} {{value1}}', {
        value0: title,
        value1: value
      })
}

function PickerTrigger(props: {
  modelLabel: string
  /** The options' values, shown after the model; empty when there are none to show. */
  optionsLabel: string
  accessibleName: string
  disabled: boolean
  disabledReason: string | null
  dispatched: boolean
  triggerRef: React.Ref<HTMLButtonElement>
  onKeyDown: React.KeyboardEventHandler<HTMLButtonElement>
}): React.JSX.Element {
  const [tooltipOpen, setTooltipOpen] = useState(false)
  // Keep the tooltip mounted but closed unless informative; changing wrapper identity would detach the open picker.
  const informative = props.disabledReason !== null || props.dispatched
  return (
    <Tooltip open={informative && tooltipOpen} onOpenChange={setTooltipOpen}>
      <TooltipTrigger asChild>
        <PopoverTrigger asChild disabled={props.disabled}>
          <Button
            ref={props.triggerRef}
            type="button"
            variant="ghost"
            size="xs"
            aria-label={props.accessibleName}
            className="max-w-64"
            onKeyDown={props.onKeyDown}
          >
            <span className="truncate text-chat-foreground">{props.modelLabel}</span>
            {props.optionsLabel ? <span className="shrink-0">{props.optionsLabel}</span> : null}
            <ChevronDown className="size-3" />
          </Button>
        </PopoverTrigger>
      </TooltipTrigger>
      <TooltipContent side="top" sideOffset={4}>
        <div className="space-y-0.5">
          {props.disabledReason ? <div>{props.disabledReason}</div> : null}
          {props.dispatched ? (
            <div>
              {translate(
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

function SessionOptionPopover(props: {
  demandModelCatalog?: () => void
  model: SessionOptionDescriptor
  options: readonly SessionOptionDescriptor[]
  isWorking: boolean
  /** Only the descriptor being saved holds its write controls. */
  pendingIds: ReadonlySet<string>
  request: NativeChatOptionPickerRequest | null
  onSet: (descriptor: SessionOptionDescriptor, value: SessionOptionValue) => void
  onAction: (descriptor: SessionOptionDescriptor) => void
  focusComposer?: () => void
}): React.JSX.Element {
  const { model, options, pendingIds, demandModelCatalog } = props
  // Why here: this unmounts with the pill, so a picker that went away comes back closed.
  const [open, setOpen] = useState(false)
  const [seenRequest, setSeenRequest] = useState<NativeChatOptionPickerRequest | null>(null)
  // The option a slash command asked for, focused in place of the search by that opening only.
  const [requestedOptionId, setRequestedOptionId] = useState<string | null>(null)
  if (props.request !== seenRequest) {
    setSeenRequest(props.request)
    if (props.request) {
      setOpen(true)
      setRequestedOptionId(props.request.id === model.id ? null : props.request.id)
    }
  }
  const wasOpen = useRef(false)
  useEffect(() => {
    if (open && !wasOpen.current) {
      demandModelCatalog?.()
    }
    wasOpen.current = open
  }, [open, demandModelCatalog])
  const focusReturn = useNativeChatPickerFocusReturn(props.focusComposer)
  const modelTitle = translate('components.native-chat.composer.model', 'Model')
  const modelLabel = nativeChatModelPillLabel(model)
  const modelName = pillAccessibleName(modelTitle, modelLabel)
  const optionsTitle = nativeChatOptionsPillTitle(options)
  const optionsLabel = nativeChatOptionValuesLabel(options)
  const modelReason = nativeChatSessionOptionDisabledReason(model.disabledReason)
  const optionsReason =
    options.length > 0 && options.every((descriptor) => !descriptor.settable)
      ? nativeChatSessionOptionDisabledReason(options[0]?.disabledReason)
      : null

  // Different descriptors can save together; hold only a repeat of the same pick.
  const set = (descriptor: SessionOptionDescriptor, value: SessionOptionValue): void => {
    if (pendingIds.has(descriptor.id)) {
      return
    }
    focusReturn.notePick()
    // Why: effort is the last thing set before typing, so its level closes the picker.
    if (descriptor.id === 'effort') {
      setOpen(false)
    }
    if (descriptor.kind.currentValue !== value) {
      props.onSet(descriptor, value)
    }
  }
  const act = (descriptor: SessionOptionDescriptor): void => {
    if (pendingIds.has(descriptor.id)) {
      return
    }
    // Why: agent-picker opens the TUI, and that picker owns focus.
    if (descriptor.action?.type !== 'agent-picker') {
      focusReturn.notePick()
    }
    setOpen(false)
    props.onAction(descriptor)
  }

  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PickerTrigger
        modelLabel={modelLabel}
        optionsLabel={optionsLabel}
        accessibleName={
          optionsLabel
            ? `${modelName}, ${pillAccessibleName(optionsTitle, optionsLabel)}`
            : modelName
        }
        disabled={props.isWorking}
        disabledReason={modelReason ?? optionsReason}
        dispatched={
          sessionOptionDispatchUnconfirmed(model) || options.some(sessionOptionDispatchUnconfirmed)
        }
        triggerRef={focusReturn.triggerRef}
        // Why: a popover trigger opens on Enter and Space only; a menu also takes ArrowDown.
        onKeyDown={(event) => {
          if (event.key === 'ArrowDown') {
            event.preventDefault()
            setOpen(true)
          }
        }}
      />
      <PopoverContent
        // Why end: the pill's label changes under an open picker; only its right edge stays put.
        align="end"
        side="top"
        collisionPadding={8}
        className="flex w-96 max-w-(--radix-popover-content-available-width) flex-col"
        onOpenAutoFocus={(event) => {
          const content = event.currentTarget
          const optionId = requestedOptionId
          setRequestedOptionId(null)
          if (!optionId || !(content instanceof HTMLElement)) {
            return
          }
          const row = content.querySelector(`[data-option-id="${CSS.escape(optionId)}"]`)
          const control =
            row?.querySelector<HTMLElement>('[aria-checked="true"]:not(:disabled)') ??
            row?.querySelector<HTMLElement>('button:not(:disabled)')
          if (control) {
            event.preventDefault()
            control.focus()
          }
        }}
        onInteractOutside={focusReturn.onInteractOutside}
        onCloseAutoFocus={focusReturn.onCloseAutoFocus}
        // Close through a level tooltip’s first Escape; let Radix handle search Escape after IME.
        onKeyDown={(event) => {
          if (event.key === 'Escape' && !(event.target instanceof HTMLInputElement)) {
            setOpen(false)
          }
        }}
      >
        {model.kind.type === 'select' && !model.action ? (
          <NativeChatModelCombobox
            choices={model.kind.choices}
            currentValue={model.kind.currentValue}
            readOnly={!model.settable}
            readOnlyReason={modelReason}
            busy={pendingIds.has(model.id)}
            onSelect={(value) => set(model, value)}
          />
        ) : (
          <NativeChatSessionOptionWriteGroup
            busy={pendingIds.has(model.id)}
            className="flex flex-col p-1"
          >
            {modelReason && !model.settable ? (
              <div className="px-2 py-1 text-xs text-muted-foreground">{modelReason}</div>
            ) : null}
            <Button
              type="button"
              variant="ghost"
              size="xs"
              disabled={!model.settable}
              className="w-full justify-start"
              onClick={() => act(model)}
            >
              {nativeChatSessionOptionActionLabel(model)}
            </Button>
          </NativeChatSessionOptionWriteGroup>
        )}
        <NativeChatSessionOptionRows
          options={options}
          shownReason={model.settable ? null : modelReason}
          pendingIds={pendingIds}
          onSet={set}
          onAction={act}
        />
      </PopoverContent>
    </Popover>
  )
}

function NativeChatSessionOptionPickersInner({
  surface,
  snapshot,
  isWorking,
  pickerRequest,
  focusComposer
}: NativeChatSessionOptionPickersProps): React.JSX.Element | null {
  const [pending, setPending] = useState<ReadonlyMap<string, PendingPick>>(() => new Map())
  // Consume requests even without a usable picker so composer remounts cannot reopen them.
  useEffect(() => pickerRequest?.consume(), [pickerRequest])
  const reportedModel = snapshot.find((descriptor) => descriptor.category === 'model')
  if (!surface || !reportedModel) {
    return null
  }
  const model = withPendingValue(reportedModel, pending.get(reportedModel.id) ?? null)
  const options = sortNativeChatSessionOptions(snapshot).map((descriptor) =>
    withPendingValue(descriptor, pending.get(descriptor.id) ?? null)
  )

  const markPending = (id: string) => (pick: PendingPick | null) => {
    setPending((current) => {
      const next = new Map(current)
      if (pick === null) {
        next.delete(id)
      } else {
        next.set(id, pick)
      }
      return next
    })
  }

  return (
    <div className="flex min-w-0 items-center text-chat-foreground-faint">
      <SessionOptionPopover
        demandModelCatalog={surface.demandModelCatalog}
        model={model}
        options={options}
        isWorking={isWorking}
        pendingIds={new Set(pending.keys())}
        request={pickerRequest ?? null}
        onSet={(descriptor, value) =>
          runSessionOptionSurfaceCall(
            { id: descriptor.id, value },
            markPending(descriptor.id),
            () => surface.setOption(descriptor.id, value)
          )
        }
        onAction={(descriptor) =>
          runSessionOptionSurfaceCall({ id: descriptor.id }, markPending(descriptor.id), () =>
            surface.invokeAction(descriptor.id)
          )
        }
        focusComposer={focusComposer}
      />
    </div>
  )
}

export const NativeChatSessionOptionPickers = memo(NativeChatSessionOptionPickersInner)
