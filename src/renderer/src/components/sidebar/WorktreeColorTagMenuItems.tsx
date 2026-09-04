import React, { useCallback, useRef, useState } from 'react'
import { Slash } from 'lucide-react'

import { DropdownMenuItem } from '@/components/ui/dropdown-menu'
import { cn } from '@/lib/utils'
import { translate } from '@/i18n/i18n'
import {
  isPresetWorkspaceColorTag,
  resolveWorkspaceColorTagSelection,
  WORKSPACE_COLOR_TAG_SWATCHES
} from '../../../../shared/workspace-color-tag'

// Why a symbol: a string literal would be swallowed by `string` and the union would collapse; the
// custom action has to stay disjoint from every hex the row can assign.
const CUSTOM_SWATCH = Symbol('workspace-color-tag-custom')
/** Swatch identity: null clears the tag, CUSTOM_SWATCH opens the picker, a hex assigns directly. */
type SwatchOption = string | null | typeof CUSTOM_SWATCH

// The empty slot leads and the custom wheel closes the row, so the presets read as one strip.
const SWATCH_OPTIONS: readonly SwatchOption[] = [
  null,
  ...WORKSPACE_COLOR_TAG_SWATCHES,
  CUSTOM_SWATCH
]

// Why derive: the wheel stands for "any color" by sweeping the same palette the row offers, so a
// palette change cannot leave the wheel showing colors the row no longer has (or missing ones it does).
const CUSTOM_SWATCH_GRADIENT = `conic-gradient(${[
  ...WORKSPACE_COLOR_TAG_SWATCHES,
  WORKSPACE_COLOR_TAG_SWATCHES[0]
].join(', ')})`

type WorktreeColorTagMenuItemsProps = {
  colorTag: string | null
  /** The selection carries more than one tag state; nothing reads as checked. */
  mixed: boolean
  disabled: boolean
  isMultiContext: boolean
  onAssignColorTag: (colorTag: string | null) => void
  onOpenCustomPicker: () => void
}

function getInitialSwatchIndex(colorTag: string | null): number {
  const index = SWATCH_OPTIONS.indexOf(colorTag)
  if (index !== -1) {
    return index
  }
  // Why: a stored custom color lives behind the wheel. Landing on the empty slot instead would
  // make Enter on the row clear the tag the user is looking at.
  return colorTag === null ? 0 : SWATCH_OPTIONS.indexOf(CUSTOM_SWATCH)
}

function getSwatchKey(swatch: SwatchOption): string {
  return swatch === CUSTOM_SWATCH ? 'custom' : (swatch ?? 'none')
}

function getSwatchLabel(swatch: SwatchOption, isSelected: boolean): string {
  if (swatch === null) {
    return translate('auto.components.sidebar.WorktreeColorTagMenuItems.noColor', 'No color')
  }
  if (swatch === CUSTOM_SWATCH) {
    return translate('auto.components.sidebar.WorktreeColorTagMenuItems.custom', 'Custom color')
  }
  return isSelected
    ? translate(
        'auto.components.sidebar.WorktreeColorTagMenuItems.removeColor',
        'Remove color {{value0}}',
        { value0: swatch }
      )
    : translate(
        'auto.components.sidebar.WorktreeColorTagMenuItems.useColor',
        'Use color {{value0}}',
        { value0: swatch }
      )
}

export function WorktreeColorTagMenuItems({
  colorTag,
  mixed,
  disabled,
  isMultiContext,
  onAssignColorTag,
  onOpenCustomPicker
}: WorktreeColorTagMenuItemsProps): React.JSX.Element {
  const [activeIndex, setActiveIndex] = useState(() => getInitialSwatchIndex(colorTag))
  // Why: the row is one menu stop, so the swatch a click or Enter lands on has to
  // survive into the item's onSelect without waiting for a state re-render.
  const activeIndexRef = useRef(activeIndex)

  const isSwatchSelected = useCallback(
    (swatch: SwatchOption): boolean => {
      if (mixed) {
        return false
      }
      if (swatch === CUSTOM_SWATCH) {
        return colorTag !== null && !isPresetWorkspaceColorTag(colorTag)
      }
      return swatch === colorTag
    },
    [colorTag, mixed]
  )

  const moveActiveIndex = useCallback((index: number) => {
    const wrapped = (index + SWATCH_OPTIONS.length) % SWATCH_OPTIONS.length
    activeIndexRef.current = wrapped
    setActiveIndex(wrapped)
  }, [])

  const handleRowKeyDown = useCallback(
    (event: React.KeyboardEvent<HTMLDivElement>) => {
      if (event.key !== 'ArrowLeft' && event.key !== 'ArrowRight') {
        return
      }
      // Why: horizontal arrows belong to the row; letting them bubble would close
      // the menu or jump to a sibling submenu instead of moving between swatches.
      event.preventDefault()
      event.stopPropagation()
      moveActiveIndex(activeIndexRef.current + (event.key === 'ArrowRight' ? 1 : -1))
    },
    [moveActiveIndex]
  )

  const handleSelect = useCallback(() => {
    const swatch = SWATCH_OPTIONS[activeIndexRef.current]
    if (swatch === CUSTOM_SWATCH) {
      onOpenCustomPicker()
      return
    }
    onAssignColorTag(resolveWorkspaceColorTagSelection(colorTag, swatch))
  }, [colorTag, onAssignColorTag, onOpenCustomPicker])

  const groupLabel = isMultiContext
    ? translate(
        'auto.components.sidebar.WorktreeColorTagMenuItems.groupColorMulti',
        'Group color for selected workspaces'
      )
    : translate('auto.components.sidebar.WorktreeColorTagMenuItems.groupColor', 'Group color')
  // Why: focus stays on the row while arrows move between swatches, so the row's own name has to
  // say which swatch Enter will activate or a screen reader hears only "Group color".
  const activeSwatch = SWATCH_OPTIONS[activeIndex] ?? null
  const rowLabel = `${groupLabel}: ${getSwatchLabel(activeSwatch, isSwatchSelected(activeSwatch))}`

  return (
    <DropdownMenuItem
      disabled={disabled}
      className="px-2 py-1.5 focus:bg-transparent dark:focus:bg-transparent"
      onSelect={handleSelect}
      onKeyDown={handleRowKeyDown}
      aria-label={rowLabel}
    >
      <div className="flex w-full items-center justify-between gap-1" role="radiogroup">
        {SWATCH_OPTIONS.map((swatch, index) => {
          const isSelected = isSwatchSelected(swatch)
          const isCustom = swatch === CUSTOM_SWATCH
          return (
            <button
              key={getSwatchKey(swatch)}
              type="button"
              role={isCustom ? 'menuitem' : 'radio'}
              tabIndex={-1}
              aria-checked={isCustom ? undefined : isSelected}
              aria-haspopup={isCustom ? 'dialog' : undefined}
              aria-label={getSwatchLabel(swatch, isSelected)}
              data-workspace-color-swatch={getSwatchKey(swatch)}
              onPointerEnter={() => moveActiveIndex(index)}
              onClick={() => {
                activeIndexRef.current = index
              }}
              className={cn(
                'flex size-4 items-center justify-center rounded-full outline-none transition-shadow',
                swatch === null && 'border border-border text-muted-foreground',
                isSelected && 'ring-2 ring-foreground ring-offset-2 ring-offset-popover',
                !isSelected &&
                  index === activeIndex &&
                  'ring-1 ring-muted-foreground ring-offset-2 ring-offset-popover'
              )}
              style={
                isCustom
                  ? { backgroundImage: CUSTOM_SWATCH_GRADIENT }
                  : swatch === null
                    ? undefined
                    : { backgroundColor: swatch }
              }
            >
              {swatch === null ? <Slash className="size-2.5" /> : null}
            </button>
          )
        })}
      </div>
    </DropdownMenuItem>
  )
}
