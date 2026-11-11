import { useId, type Ref } from 'react'
import { Checkbox } from '@/components/ui/checkbox'
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip'
import { ShortcutKeyCombo } from '@/components/ShortcutKeyCombo'
import type { ShortcutKeyComboDetails } from '@/hooks/useShortcutLabel'
import { useTranslate } from '@/i18n/use-translate'

export function DiffViewedCheckbox({
  ref,
  viewed,
  disabled,
  onToggle,
  shortcut
}: {
  ref?: Ref<HTMLDivElement>
  viewed: boolean
  disabled: boolean
  onToggle: () => void
  shortcut?: ShortcutKeyComboDetails
}): React.JSX.Element {
  const id = useId()
  const t = useTranslate()
  const control = (
    <div
      ref={ref}
      className="flex shrink-0 items-center gap-1.5 px-1 text-xs text-muted-foreground"
    >
      <Checkbox id={id} checked={viewed} disabled={disabled} onCheckedChange={onToggle} />
      <label htmlFor={id} className="cursor-pointer select-none">
        {t('diffReview.viewed', 'Viewed')}
      </label>
    </div>
  )
  return shortcut && shortcut.keys.length > 0 ? (
    <Tooltip>
      <TooltipTrigger asChild>{control}</TooltipTrigger>
      <TooltipContent side="top" sideOffset={4}>
        <ShortcutKeyCombo keys={shortcut.keys} doubleTap={shortcut.doubleTap} />
      </TooltipContent>
    </Tooltip>
  ) : (
    control
  )
}
