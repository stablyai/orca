import React, { type CSSProperties } from 'react'
import { cn } from '@/lib/utils'
import { translate } from '@/i18n/i18n'
import { getTabColorOptions, type TabColorOption } from './tab-color-options'

export type TabColorSwatchRenderProps = {
  color: TabColorOption
  isSelected: boolean
  className: string
  style: CSSProperties | undefined
  ariaLabel: string
  children: React.ReactNode
}

// Why: both the terminal tab context menu and the Activity row context menu
// render the same swatch grid. Sharing the class names, selected-ring styling,
// inline color, and the "none" diagonal strike here keeps the two menus from
// drifting apart while each still owns its own menu-item wrapper primitive.
export function getTabColorSwatchClassName(isSelected: boolean, value: string | null): string {
  return cn(
    'relative h-4 w-4 min-w-4 rounded-full border p-0',
    isSelected ? 'ring-1 ring-foreground/70 ring-offset-1 ring-offset-popover' : '',
    value ? 'border-transparent' : 'border-muted-foreground/50 bg-transparent'
  )
}

export function TabColorSwatchGrid({
  selectedColor,
  className,
  renderSwatch
}: {
  selectedColor: string | null | undefined
  className?: string
  renderSwatch: (props: TabColorSwatchRenderProps) => React.ReactNode
}): React.JSX.Element {
  return (
    <div className={cn('flex flex-wrap gap-2', className)}>
      {getTabColorOptions().map((color) => {
        const isSelected = selectedColor === color.value
        // Why: shared aria-label so both the terminal tab menu and the Activity
        // row menu expose the same accessible name to screen readers without
        // each call site re-deriving the translate keys.
        const ariaLabel =
          color.value === null
            ? translate('auto.components.tab.bar.tab-color-swatch.clearTabColor', 'Clear tab color')
            : translate(
                'auto.components.tab.bar.tab-color-swatch.setTabColor',
                'Set tab color {{value0}}',
                { value0: color.label }
              )
        return renderSwatch({
          color,
          isSelected,
          className: getTabColorSwatchClassName(isSelected, color.value),
          style: color.value ? { backgroundColor: color.value } : undefined,
          ariaLabel,
          children:
            color.value === null ? (
              <span className="absolute block h-px w-3 rotate-45 bg-muted-foreground/80" />
            ) : null
        })
      })}
    </div>
  )
}
