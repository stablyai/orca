import { useId, useLayoutEffect, useRef, useState } from 'react'
import { cn } from '@/lib/utils'
import { Button } from '@/components/ui/button'
import { Switch } from '@/components/ui/switch'
import { Slider } from '@/components/ui/slider'
import { ToggleGroup, ToggleGroupItem } from '@/components/ui/toggle-group'
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip'
import { sortNativeChatSessionOptions } from '../../../../shared/native-chat/input/native-chat-session-option-snapshot'
import {
  isReadOnlySessionOptionValue,
  type SessionOptionDescriptor,
  type SessionOptionSelectChoice,
  type SessionOptionValue
} from '../../../../shared/native-chat/input/native-chat-session-options'
import {
  nativeChatSessionChoiceLabel,
  nativeChatSessionChoiceShortLabel,
  nativeChatSessionOptionActionLabel,
  nativeChatSessionOptionDisabledReason,
  nativeChatSessionOptionLabel
} from '../../../../shared/native-chat-session-option-labels'
import { sayNativeChatSessionOptionTranslated as say } from './native-chat-session-option-labels-text'
import { NativeChatSessionOptionWriteGroup } from './NativeChatSessionOptionWriteGroup'

type NativeChatSessionOptionRowsProps = {
  /** The current model's options, in display order. */
  options: readonly SessionOptionDescriptor[]
  /** A reason already shown above the list, so a row does not repeat it. */
  shownReason: string | null
  /** Each pending descriptor holds only its own controls. */
  pendingIds: ReadonlySet<string>
  onSet: (descriptor: SessionOptionDescriptor, value: SessionOptionValue) => void
  /** A value-less action; it has nothing to show in place, so it closes the picker. */
  onAction: (descriptor: SessionOptionDescriptor) => void
  /** False when the caller already separates these rows from what sits above them. */
  divided?: boolean
  /** Settings grids provide their own inset and spacing between option blocks. */
  layout?: 'menu' | 'settings'
}

// Retain missing rows disabled for this visit so model changes cannot slide the picker under the pointer.
function withEarlierRows(
  earlier: readonly SessionOptionDescriptor[],
  current: readonly SessionOptionDescriptor[]
): readonly SessionOptionDescriptor[] {
  const gone = earlier.filter((row) => !current.some((option) => option.id === row.id))
  return gone.length === 0 ? current : sortNativeChatSessionOptions([...current, ...gone])
}

function LevelSegment(props: {
  optionId: string
  choice: SessionOptionSelectChoice
}): React.JSX.Element {
  const { optionId, choice } = props
  const detailId = useId()
  const label = nativeChatSessionChoiceLabel(choice, say, optionId)
  const shortLabel = nativeChatSessionChoiceShortLabel(choice, say, optionId)
  // What the segment's text leaves out: the full name behind an abbreviation, and the description.
  const detail = [label === shortLabel ? null : label, choice.description].filter(Boolean).join(' ')
  if (!detail) {
    return <ToggleGroupItem value={choice.value}>{shortLabel}</ToggleGroupItem>
  }
  return (
    <Tooltip>
      {/* Wrap the tooltip trigger so its data-state cannot replace the segment’s on/off state. */}
      <TooltipTrigger asChild>
        <span className="inline-flex">
          {/* Link the full description directly; the tooltip links only its wrapper while open. */}
          <ToggleGroupItem value={choice.value} aria-describedby={detailId}>
            {shortLabel}
          </ToggleGroupItem>
          <span id={detailId} className="sr-only">
            {detail}
          </span>
        </span>
      </TooltipTrigger>
      <TooltipContent side="top" sideOffset={4}>
        <div>{label}</div>
        {choice.description ? <div>{choice.description}</div> : null}
      </TooltipContent>
    </Tooltip>
  )
}

function EffortSlider({
  descriptor,
  gone,
  disabled,
  onSet
}: {
  descriptor: SessionOptionDescriptor & { kind: { type: 'select' } }
  gone: boolean
  disabled: boolean
  onSet: (value: SessionOptionValue) => void
}): React.JSX.Element {
  const { kind } = descriptor
  const [draft, setDraft] = useState<string | null>(null)
  const selectCurrentOnRelease = useRef(false)
  const currentIndex = gone
    ? -1
    : kind.choices.findIndex((choice) => choice.value === kind.currentValue)
  const index =
    draft === null ? currentIndex : kind.choices.findIndex((choice) => choice.value === draft)
  const choice = index < 0 ? undefined : kind.choices[index]
  const label = nativeChatSessionOptionLabel(descriptor, say)
  const valueLabel = choice ? nativeChatSessionChoiceLabel(choice, say, descriptor.id) : '—'
  const shortValueLabel = choice
    ? nativeChatSessionChoiceShortLabel(choice, say, descriptor.id)
    : '—'
  return (
    <div className="space-y-2 px-2 py-1.5">
      <div className="flex min-w-0 items-baseline justify-between gap-3 text-xs">
        <span className="whitespace-nowrap text-muted-foreground">{label}</span>
        {choice && !gone ? (
          <Tooltip>
            <TooltipTrigger asChild>
              <span className="min-w-0 truncate whitespace-nowrap text-foreground">
                {shortValueLabel}
              </span>
            </TooltipTrigger>
            <TooltipContent side="top" sideOffset={4}>
              {valueLabel}
            </TooltipContent>
          </Tooltip>
        ) : (
          <span className="text-foreground">—</span>
        )}
      </div>
      <Slider
        min={0}
        max={kind.choices.length - 1}
        step={1}
        value={[Math.max(index, 0)]}
        disabled={disabled}
        thumbLabels={[label]}
        thumbValueLabels={[
          [gone ? '—' : valueLabel, choice?.description].filter(Boolean).join(' · ')
        ]}
        onPointerDownCapture={() => {
          selectCurrentOnRelease.current = !disabled && descriptor.valueSource === 'default'
        }}
        onPointerUpCapture={() => {
          if (selectCurrentOnRelease.current && draft === null && choice) {
            onSet(choice.value)
          }
          selectCurrentOnRelease.current = false
        }}
        onKeyDown={(event) => {
          if (
            !disabled &&
            descriptor.valueSource === 'default' &&
            choice &&
            (event.key === 'Enter' || event.key === ' ')
          ) {
            event.preventDefault()
            onSet(choice.value)
          }
        }}
        onValueChange={([nextIndex]) => {
          if (nextIndex !== undefined) {
            setDraft(kind.choices[nextIndex]?.value ?? null)
          }
        }}
        onPointerCancel={() => {
          selectCurrentOnRelease.current = false
          setDraft(null)
        }}
        onLostPointerCapture={() => {
          selectCurrentOnRelease.current = false
          setDraft(null)
        }}
        onValueCommit={([nextIndex]) => {
          setDraft(null)
          const next = nextIndex === undefined ? undefined : kind.choices[nextIndex]
          if (next) {
            onSet(next.value)
          }
        }}
      />
    </div>
  )
}

function OptionRow(props: {
  descriptor: SessionOptionDescriptor
  layout: 'menu' | 'settings'
  pending: boolean
  /** Kept from an earlier model in this visit; the current one does not offer it. */
  gone: boolean
  onSet: (value: SessionOptionValue) => void
  onAction: () => void
}): React.JSX.Element {
  const { descriptor, layout, gone, pending, onSet, onAction } = props
  const labelId = useId()
  const label = nativeChatSessionOptionLabel(descriptor, say)
  const off = gone || !descriptor.settable
  if (descriptor.action?.type === 'toggle-command') {
    return (
      <Button
        type="button"
        variant="ghost"
        size="xs"
        disabled={off}
        className="w-full justify-start"
        onClick={onAction}
      >
        {nativeChatSessionOptionActionLabel(descriptor, say)}
      </Button>
    )
  }
  if (descriptor.action) {
    return (
      <div
        className={cn(
          'flex min-h-7 items-center justify-between gap-3',
          layout === 'menu' && 'pl-2'
        )}
      >
        <span className="text-xs text-muted-foreground">{label}</span>
        <Button type="button" variant="ghost" size="xs" disabled={off} onClick={onAction}>
          {nativeChatSessionOptionActionLabel(descriptor, say)}
        </Button>
      </div>
    )
  }
  if (descriptor.kind.type === 'boolean') {
    return (
      <label
        className={cn(
          'flex min-h-7 items-center justify-between gap-3 text-xs text-muted-foreground',
          layout === 'menu' && 'px-2'
        )}
      >
        {label}
        <Switch
          checked={!gone && descriptor.kind.currentValue}
          disabled={off}
          onCheckedChange={onSet}
        />
      </label>
    )
  }
  const current = descriptor.kind.currentValue
  const only = descriptor.kind.choices[0]
  if (only && isReadOnlySessionOptionValue(descriptor)) {
    // A row kept from the previous model names no value under this one, as a switched-off row.
    return (
      <div
        className={cn(
          'flex min-h-7 items-center justify-between gap-3 text-xs',
          layout === 'menu' && 'px-2'
        )}
      >
        <span className="text-muted-foreground">{label}</span>
        {gone ? null : (
          <span className="text-foreground">
            {nativeChatSessionChoiceLabel(only, say, descriptor.id)}
          </span>
        )}
      </div>
    )
  }
  if (
    descriptor.id === 'effort' &&
    descriptor.kind.choices.length > 1 &&
    (gone || descriptor.kind.choices.some((choice) => choice.value === current))
  ) {
    return (
      <EffortSlider
        key={JSON.stringify([
          descriptor.kind.choices.map((choice) => choice.value),
          current,
          off || pending
        ])}
        descriptor={{ ...descriptor, kind: descriptor.kind }}
        gone={gone}
        disabled={off || pending}
        onSet={onSet}
      />
    )
  }
  return (
    <div
      className={cn(
        'flex min-h-7 flex-wrap items-center justify-between gap-x-3 gap-y-1',
        layout === 'menu' && 'pl-2'
      )}
    >
      <span id={labelId} className="text-xs text-muted-foreground">
        {label}
      </span>
      <ToggleGroup
        type="single"
        variant="segmented"
        size="xs"
        spacing={0.5}
        role="radiogroup"
        aria-labelledby={labelId}
        value={gone ? '' : (current ?? '')}
        disabled={off}
        onValueChange={(value) => {
          // Radix reports a press on the level in use as an empty value; it is still a press.
          const pressed = value || current
          if (pressed) {
            onSet(pressed)
          }
        }}
        // Why -ml-2: a wrapped group lines its first label up under the row's.
        className="-ml-2 flex-wrap"
      >
        {descriptor.kind.choices.map((choice) => (
          <LevelSegment key={choice.value} optionId={descriptor.id} choice={choice} />
        ))}
      </ToggleGroup>
    </div>
  )
}

export function NativeChatSessionOptionRows({
  options,
  shownReason,
  pendingIds,
  onSet,
  onAction,
  divided = true,
  layout = 'menu'
}: NativeChatSessionOptionRowsProps): React.JSX.Element {
  const shown = useRef(options)
  const rows = withEarlierRows(shown.current, options)
  // Why after commit: a render React throws away must not leave a row behind.
  useLayoutEffect(() => {
    shown.current = rows
  })
  const frame = useRef<HTMLDivElement>(null)
  const content = useRef<HTMLDivElement>(null)
  // Animate measured height as model options change, matching the model list’s size transition.
  useLayoutEffect(() => {
    const frameElement = frame.current
    const contentElement = content.current
    if (!frameElement || !contentElement) {
      return
    }
    const publish = (): void => {
      frameElement.style.setProperty('--option-rows-height', `${contentElement.offsetHeight}px`)
    }
    publish()
    const observer = new ResizeObserver(publish)
    observer.observe(contentElement)
    return () => observer.disconnect()
  }, [])
  return (
    <div
      ref={frame}
      className={cn(
        'h-(--option-rows-height) shrink-0 overflow-hidden transition-[height] duration-150 ease-out motion-reduce:transition-none',
        layout === 'settings' && rows.length === 0 && 'hidden'
      )}
    >
      <div ref={content}>
        {rows.length > 0 ? (
          <div className={cn(divided && 'border-t border-border', layout === 'menu' && 'p-1')}>
            <div className={cn('flex flex-col', layout === 'menu' ? 'gap-0.5' : 'gap-2.5')}>
              {rows.map((descriptor) => {
                const reason = nativeChatSessionOptionDisabledReason(descriptor.disabledReason, say)
                return (
                  <NativeChatSessionOptionWriteGroup
                    key={descriptor.id}
                    busy={pendingIds.has(descriptor.id)}
                  >
                    <div data-option-id={descriptor.id}>
                      <OptionRow
                        descriptor={descriptor}
                        layout={layout}
                        pending={pendingIds.has(descriptor.id)}
                        gone={!options.some((option) => option.id === descriptor.id)}
                        onSet={(value) => onSet(descriptor, value)}
                        onAction={() => onAction(descriptor)}
                      />
                      {reason && !descriptor.settable && reason !== shownReason ? (
                        <div className="px-2 pb-1 text-xs text-muted-foreground">{reason}</div>
                      ) : null}
                    </div>
                  </NativeChatSessionOptionWriteGroup>
                )
              })}
            </div>
          </div>
        ) : null}
      </div>
    </div>
  )
}
