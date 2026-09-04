import * as React from 'react'
import { HexColorPicker } from 'react-colorful'

import { normalizeRepoBadgeColor, resolveRepoBadgeColor } from '../../../../shared/repo-badge-color'
import { cn } from '@/lib/utils'
import { Button } from './button'
import { Input } from './input'
import { Label } from './label'
import { Popover, PopoverContent, PopoverTrigger } from './popover'
import { translate } from '@/i18n/i18n'

type ColorPickerFieldsProps = {
  /** Names the control; the wheel's accessible name is derived from it. */
  label: string
  inputId: string
  /** What the wheel shows — always a complete color. */
  wheelColor: string
  /** What the hex field holds, complete or not. */
  draft: string
  hasInvalidDraft: boolean
  placeholder?: string
  onWheelChange: (hex: string) => void
  onDraftChange: (value: string) => void
  onDraftFocus?: () => void
  onDraftBlur?: () => void
}

/**
 * The wheel plus validated hex field shared by every color picker surface. Callers own the state
 * and decide what a change means (immediate onChange, preview-then-commit, …); this keeps the
 * focus-ring treatment, the mono hex readout, and the invalid-input feedback identical everywhere.
 */
export function ColorPickerFields({
  label,
  inputId,
  wheelColor,
  draft,
  hasInvalidDraft,
  placeholder,
  onWheelChange,
  onDraftChange,
  onDraftFocus,
  onDraftBlur
}: ColorPickerFieldsProps): React.JSX.Element {
  return (
    <div className="space-y-3">
      <HexColorPicker
        color={wheelColor}
        onChange={onWheelChange}
        aria-label={translate('auto.components.ui.color.picker.1cec618bcc', '{{value0}} picker', {
          value0: label
        })}
        className="[&_.react-colorful__hue]:rounded-b-md [&_.react-colorful__interactive:focus_.react-colorful__pointer]:ring-[3px] [&_.react-colorful__interactive:focus_.react-colorful__pointer]:ring-ring/50 [&_.react-colorful__pointer]:border-popover"
        style={{ width: '100%', height: 180 }}
      />
      <div className="flex items-center justify-between gap-3">
        <Label htmlFor={inputId}>
          {translate('auto.components.ui.color.picker.faa855a582', 'Hex')}
        </Label>
        <span className="font-mono text-xs uppercase text-muted-foreground">{wheelColor}</span>
      </div>
      <Input
        id={inputId}
        value={draft}
        onFocus={onDraftFocus}
        onChange={(event) => onDraftChange(event.target.value)}
        onBlur={onDraftBlur}
        placeholder={placeholder}
        aria-invalid={hasInvalidDraft}
        className="font-mono text-xs uppercase"
      />
      {hasInvalidDraft ? (
        <p className="text-xs text-destructive">
          {translate('auto.components.ui.color.picker.ebcf6ba29e', 'Invalid hex color.')}
        </p>
      ) : null}
    </div>
  )
}

type ColorPickerProps = {
  value: string
  onChange: (value: string) => void
  label: string
  className?: string
  defaultOpen?: boolean
  selected?: boolean
  triggerLabel?: string
  showHexInTrigger?: boolean
}

const FULL_HEX_COLOR_PATTERN = /^#?[0-9a-fA-F]{6}$/

export function ColorPicker({
  value,
  onChange,
  label,
  className,
  defaultOpen,
  selected,
  triggerLabel,
  showHexInTrigger
}: ColorPickerProps): React.JSX.Element {
  const inputId = React.useId()
  const currentColor = resolveRepoBadgeColor(value)
  const [draftState, setDraftState] = React.useState(() => ({
    syncedColor: currentColor,
    draft: currentColor,
    isEditing: false
  }))
  const draft =
    draftState.isEditing || draftState.syncedColor === currentColor
      ? draftState.draft
      : currentColor
  const draftColor = normalizeRepoBadgeColor(draft)
  const swatchColor = draftColor ?? currentColor
  const hasInvalidDraft = draft.trim().length > 0 && !draftColor
  const shouldShowTriggerHex = showHexInTrigger ?? !triggerLabel

  const updateDraft = (nextDraft: string): void => {
    const nextColor = normalizeRepoBadgeColor(nextDraft)
    setDraftState({ syncedColor: currentColor, draft: nextDraft, isEditing: true })
    if (nextColor && FULL_HEX_COLOR_PATTERN.test(nextDraft.trim())) {
      onChange(nextColor)
    }
  }

  const updateColor = (nextColor: string): void => {
    const normalized = resolveRepoBadgeColor(nextColor)
    setDraftState({ syncedColor: currentColor, draft: normalized, isEditing: true })
    onChange(normalized)
  }

  return (
    <Popover defaultOpen={defaultOpen}>
      <PopoverTrigger asChild>
        <Button
          type="button"
          variant="outline"
          size="sm"
          className={cn(
            'h-8 gap-2 px-2.5',
            selected ? 'ring-2 ring-foreground ring-offset-2 ring-offset-background' : null,
            className
          )}
          aria-label={label}
          aria-pressed={selected}
        >
          <span
            aria-hidden="true"
            className="size-4 rounded-[4px] border border-border/70"
            style={{ backgroundColor: currentColor }}
          />
          {triggerLabel ? <span className="text-xs">{triggerLabel}</span> : null}
          {shouldShowTriggerHex ? (
            <span className="font-mono text-xs uppercase">{currentColor}</span>
          ) : null}
        </Button>
      </PopoverTrigger>
      <PopoverContent align="start" className="w-64 p-3">
        <ColorPickerFields
          label={label}
          inputId={inputId}
          wheelColor={swatchColor}
          draft={draft}
          hasInvalidDraft={hasInvalidDraft}
          placeholder={currentColor}
          onWheelChange={updateColor}
          onDraftChange={updateDraft}
          onDraftFocus={() => setDraftState({ syncedColor: currentColor, draft, isEditing: true })}
          onDraftBlur={() => {
            if (draftColor) {
              setDraftState({ syncedColor: currentColor, draft: draftColor, isEditing: false })
              onChange(draftColor)
            } else {
              setDraftState({ syncedColor: currentColor, draft: currentColor, isEditing: false })
            }
          }}
        />
      </PopoverContent>
    </Popover>
  )
}
