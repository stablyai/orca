import {
  NativeChatModelPickerTrigger,
  nativeChatModelPillAccessibleName
} from './NativeChatModelPickerTrigger'
import { memo, useEffect, useRef, useState } from 'react'
import { Button } from '@/components/ui/button'
import { Popover, PopoverContent } from '@/components/ui/popover'
import { useTranslate } from '@/i18n/use-translate'
import { useUiLanguageRevision } from '@/i18n/use-ui-language-revision'
import { sortNativeChatSessionOptions } from '../../../../../../../shared/native-chat/input/session-options/native-chat-session-option-snapshot'
import {
  sessionOptionDispatchUnconfirmed,
  type SessionOptionDescriptor,
  type SessionOptionsSurface,
  type SessionOptionValue
} from '../../../../../../../shared/native-chat/input/native-chat-session-options'
import {
  nativeChatModelPillLabel,
  nativeChatOptionValuesLabel,
  nativeChatOptionsPillTitle,
  nativeChatSessionOptionActionLabel,
  nativeChatSessionChoiceLabel,
  selectedNativeChatChoice,
  nativeChatSessionOptionDisabledReason
} from '../../../../../../../shared/native-chat/input/session-options/native-chat-session-option-labels'
import { sayNativeChatSessionOptionTranslated as say } from './native-chat-session-option-labels-text'
import type { NativeChatOptionPickerRequest } from './native-chat-option-picker-request'
import { runSessionOptionSurfaceCall } from './native-chat-session-option-surface-call'
import { NativeChatModelCombobox } from './NativeChatModelCombobox'
import { useNativeChatPickerFocusReturn } from '../../../composer/focus/native-chat-picker-focus-return'
import { NativeChatSessionOptionRows } from './NativeChatSessionOptionRows'
import { NativeChatSessionOptionWriteGroup } from './NativeChatSessionOptionWriteGroup'
import { NativeChatModelPresets } from './NativeChatModelPresets'
import { useNativeChatModelShortcuts } from './use-native-chat-model-shortcuts'
import {
  applyNativeChatModelPreset,
  currentNativeChatModelPreset,
  useNativeChatModelPresets,
  type ModelPresetSlot,
  type NativeChatModelPreset
} from './native-chat-model-presets'
import { toast } from 'sonner'

export type NativeChatSessionOptionPickersProps = {
  surface: SessionOptionsSurface | null
  snapshot: SessionOptionDescriptor[]
  isWorking: boolean
  presetScope?: string
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

function SessionOptionPopover(props: {
  presetScope?: string
  onApplyPreset: (preset: NativeChatModelPreset) => Promise<void>
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
  const t = useTranslate()
  const { model, options, pendingIds, demandModelCatalog } = props
  const { presets, save } = useNativeChatModelPresets(props.presetScope)
  const currentPreset = currentNativeChatModelPreset([model, ...options])
  const [applyingPreset, setApplyingPreset] = useState(false)
  const applyingRef = useRef(false)
  const rootRef = useRef<HTMLDivElement>(null)
  const contentRef = useRef<HTMLDivElement>(null)
  const canOpen = [model, ...options].some(
    (descriptor) =>
      descriptor.settable &&
      !applyingPreset &&
      !pendingIds.has(descriptor.id) &&
      (!props.isWorking || descriptor.transport === 'agent-session')
  )
  // Why here: this unmounts with the pill, so a picker that went away comes back closed.
  const [open, setOpen] = useState(false)
  const [seenRequest, setSeenRequest] = useState<NativeChatOptionPickerRequest | null>(null)
  // The option a slash command asked for, focused in place of the search by that opening only.
  const [requestedOptionId, setRequestedOptionId] = useState<string | null>(null)
  if (props.request !== seenRequest) {
    setSeenRequest(props.request)
    if (props.request && canOpen) {
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
  const applyPreset = (slot: ModelPresetSlot): void => {
    if (!canOpen || applyingRef.current || pendingIds.size > 0) {
      return
    }
    const preset = presets[slot - 1]
    if (!preset) {
      toast.info(
        t(
          'components.native-chat.modelPresets.unconfiguredSlot',
          'Preset {{slot}} has no model assigned',
          { slot }
        )
      )
      return
    }
    focusReturn.notePick()
    setOpen(false)
    runSessionOptionSurfaceCall(
      true,
      (pending) => {
        applyingRef.current = Boolean(pending)
        setApplyingPreset(Boolean(pending))
      },
      () => props.onApplyPreset(preset)
    )
  }
  useNativeChatModelShortcuts({
    enabled: Boolean(props.presetScope),
    rootRef,
    contentRef,
    open: () => {
      if (canOpen) {
        setOpen(true)
      }
    },
    apply: applyPreset
  })
  const modelTitle = t('components.native-chat.composer.model', 'Model')
  const modelLabel = nativeChatModelPillLabel(model, say)
  const effort = options.find((option) => option.id === 'effort')
  const effortChoice =
    effort && effort.valueSource !== 'unknown' ? selectedNativeChatChoice(effort) : null
  const knownModel = model.valueSource !== 'unknown' && selectedNativeChatChoice(model)
  const tooltipLabel = knownModel
    ? effortChoice
      ? t('components.native-chat.composer.modelAndEffortValue', '{{model}} · {{effort}}', {
          model: modelLabel,
          effort: nativeChatSessionChoiceLabel(effortChoice, say, 'effort')
        })
      : modelLabel
    : t('components.native-chat.composer.modelAndEffort', 'Model and effort')
  const modelName = knownModel
    ? nativeChatModelPillAccessibleName(modelTitle, tooltipLabel, t)
    : tooltipLabel
  const optionsTitle = nativeChatOptionsPillTitle(options, say)
  const optionsLabel = nativeChatOptionValuesLabel(options, say)
  const modelReason = nativeChatSessionOptionDisabledReason(model.disabledReason, say)
  const optionsReason =
    options.length > 0 && options.every((descriptor) => !descriptor.settable)
      ? nativeChatSessionOptionDisabledReason(options[0]?.disabledReason, say)
      : null

  // Different descriptors can save together; hold only a repeat of the same pick.
  const set = (descriptor: SessionOptionDescriptor, value: SessionOptionValue): void => {
    if (applyingRef.current || pendingIds.has(descriptor.id)) {
      return
    }
    focusReturn.notePick()
    // Why: effort is the last thing set before typing, so its level closes the picker.
    if (descriptor.id === 'effort') {
      setOpen(false)
    }
    if (
      descriptor.valueSource === 'unknown' ||
      descriptor.valueSource === 'default' ||
      descriptor.kind.currentValue !== value
    ) {
      props.onSet(descriptor, value)
    }
  }
  const act = (descriptor: SessionOptionDescriptor): void => {
    if (applyingRef.current || pendingIds.has(descriptor.id)) {
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
    <div ref={rootRef}>
      <Popover open={open} onOpenChange={(next) => setOpen(next && canOpen)}>
        <NativeChatModelPickerTrigger
          modelLabel={modelLabel}
          optionsLabel={optionsLabel}
          tooltipLabel={tooltipLabel}
          accessibleName={
            optionsLabel
              ? `${modelName}, ${nativeChatModelPillAccessibleName(optionsTitle, optionsLabel, t)}`
              : modelName
          }
          disabled={!canOpen}
          disabledReason={modelReason ?? optionsReason}
          dispatched={
            sessionOptionDispatchUnconfirmed(model) ||
            options.some(sessionOptionDispatchUnconfirmed)
          }
          triggerRef={focusReturn.triggerRef}
          // Why: a popover trigger opens on Enter and Space only; a menu also takes ArrowDown.
          onKeyDown={(event) => {
            if (event.key === 'ArrowDown' && canOpen) {
              event.preventDefault()
              setOpen(true)
            }
          }}
        />
        <PopoverContent
          ref={contentRef}
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
          // Escape from a portaled child (the speed list) closes only that child.
          onKeyDown={(event) => {
            if (
              event.key === 'Escape' &&
              !(event.target instanceof HTMLInputElement) &&
              event.target instanceof Node &&
              event.currentTarget.contains(event.target)
            ) {
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
                {nativeChatSessionOptionActionLabel(model, say)}
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
          {props.presetScope ? (
            <NativeChatModelPresets
              presets={presets}
              currentPreset={currentPreset}
              busy={applyingPreset || pendingIds.size > 0 || !canOpen}
              onApply={applyPreset}
              onSave={(slot) => {
                if (currentPreset && !save(slot, currentPreset)) {
                  toast.error(
                    t(
                      'components.native-chat.modelPresets.saveFailed',
                      'Could not save model preset'
                    )
                  )
                }
              }}
              onClear={(slot) => {
                if (!save(slot, null)) {
                  toast.error(
                    t(
                      'components.native-chat.modelPresets.saveFailed',
                      'Could not save model preset'
                    )
                  )
                }
              }}
            />
          ) : null}
        </PopoverContent>
      </Popover>
    </div>
  )
}

function NativeChatSessionOptionPickersInner({
  surface,
  snapshot,
  isWorking,
  presetScope,
  pickerRequest,
  focusComposer
}: NativeChatSessionOptionPickersProps): React.JSX.Element | null {
  useUiLanguageRevision()
  const [pending, setPending] = useState<ReadonlyMap<string, PendingPick>>(() => new Map())
  // Consume requests even without a usable picker so composer remounts cannot reopen them.
  useEffect(() => pickerRequest?.consume(), [pickerRequest])
  const reportedModel = snapshot.find((descriptor) => descriptor.category === 'model')
  if (!surface || !reportedModel) {
    return null
  }
  const model = withPendingValue(reportedModel, pending.get(reportedModel.id) ?? null)
  const options = sortNativeChatSessionOptions(snapshot)
    .filter((descriptor) => descriptor.id !== 'interactionMode')
    .map((descriptor) => withPendingValue(descriptor, pending.get(descriptor.id) ?? null))

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
        presetScope={presetScope}
        onApplyPreset={(preset) => applyNativeChatModelPreset(surface, preset, isWorking)}
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
