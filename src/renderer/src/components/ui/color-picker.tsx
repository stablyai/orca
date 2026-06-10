import * as React from 'react'
import { HexColorPicker } from 'react-colorful'

import { normalizeRepoBadgeColor, resolveRepoBadgeColor } from '../../../../shared/repo-badge-color'
import { cn } from '@/lib/utils'
import { Button } from './button'
import { Input } from './input'
import { Label } from './label'
import { Popover, PopoverContent, PopoverTrigger } from './popover'
import { translate } from '@/i18n/i18n'

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
        <div className="space-y-3">
          <HexColorPicker
            color={swatchColor}
            onChange={updateColor}
            aria-label={translate("auto.components.ui.color.picker.1cec618bcc", "{{value0}} picker", { value0: label })}
            className="[&_.react-colorful__hue]:rounded-b-md [&_.react-colorful__interactive:focus_.react-colorful__pointer]:ring-[3px] [&_.react-colorful__interactive:focus_.react-colorful__pointer]:ring-ring/50 [&_.react-colorful__pointer]:border-popover"
            style={{ width: '100%', height: 180 }}
          />
          <div className="flex items-center justify-between gap-3">
            <Label htmlFor={inputId}>{translate("auto.components.ui.color.picker.faa855a582", "Hex")}</Label>
            <span className="font-mono text-xs uppercase text-muted-foreground">{swatchColor}</span>
          </div>
          <Input
            id={inputId}
            value={draft}
            onFocus={() =>
              setDraftState({
                syncedColor: currentColor,
                draft,
                isEditing: true
              })
            }
            onChange={(event) => updateDraft(event.target.value)}
            onBlur={() => {
              if (draftColor) {
                setDraftState({ syncedColor: currentColor, draft: draftColor, isEditing: false })
                onChange(draftColor)
              } else {
                setDraftState({ syncedColor: currentColor, draft: currentColor, isEditing: false })
              }
            }}
            placeholder={currentColor}
            aria-invalid={hasInvalidDraft}
            className="font-mono text-xs uppercase"
          />
          {hasInvalidDraft ? <p className="text-xs text-destructive">{translate("auto.components.ui.color.picker.ebcf6ba29e", "Invalid hex color.")}</p> : null}
        </div>
      </PopoverContent>
    </Popover>
  )
}
