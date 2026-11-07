import { useRef, useState } from 'react'
import { Slider } from '@/components/ui/slider'
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip'
import type {
  SessionOptionDescriptor,
  SessionOptionValue
} from '../../../../shared/native-chat/input/native-chat-session-options'
import {
  nativeChatSessionChoiceLabel,
  nativeChatSessionChoiceShortLabel,
  nativeChatSessionOptionLabel
} from '../../../../shared/native-chat/input/native-chat-session-option-labels'
import { sayNativeChatSessionOptionTranslated as say } from './native-chat-session-option-labels-text'

export function EffortSlider({
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
