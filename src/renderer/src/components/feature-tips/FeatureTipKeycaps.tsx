import { Fragment, type JSX } from 'react'
import type { KeybindingActionId } from '../../../../shared/keybindings/types'
import {
  formatShortcutKeyComboDetails,
  useShortcutKeyDetails,
  type ShortcutKeyComboDetails
} from '@/lib/keyboard/useShortcutLabel'
import { getShortcutPlatform } from '@/lib/keyboard/shortcut-platform'
import { cn } from '@/lib/class-names'

/** The live binding, or the platform default when it is unbound, so a demo always has a key to press. */
export function useFeatureTipShortcut(actionId: KeybindingActionId): ShortcutKeyComboDetails {
  const shortcut = useShortcutKeyDetails(actionId)
  if (shortcut.keys.length > 0) {
    return shortcut
  }
  return formatShortcutKeyComboDetails(actionId)[0] ?? shortcut
}

/** Demo keycaps that sink one after another while `pressed`. */
export function FeatureTipKeycaps({
  shortcut,
  pressed,
  macGlyphs = false,
  className
}: {
  shortcut: ShortcutKeyComboDetails
  pressed: boolean
  /** Join keys like ShortcutKeyCombo: adjacent on Mac, "+" on Windows/Linux. */
  macGlyphs?: boolean
  className?: string
}): JSX.Element | null {
  if (shortcut.keys.length === 0) {
    return null
  }
  const joinWithPlus = !shortcut.doubleTap && !(macGlyphs && getShortcutPlatform() === 'darwin')
  return (
    <div className={cn('inline-flex items-center gap-1.5', className)}>
      {shortcut.keys.map((key, index) => (
        <Fragment key={`${key}-${index}`}>
          {index > 0 && joinWithPlus ? (
            <span className="text-xs text-muted-foreground" aria-hidden="true">
              +
            </span>
          ) : null}
          <span
            className={`inline-flex h-7 min-w-7 items-center justify-center rounded-md border border-border/80 px-2 text-xs font-semibold text-muted-foreground shadow-xs transition-[transform,background-color] duration-150 ease-out ${
              pressed
                ? 'translate-y-[1.5px] bg-foreground/[0.18]'
                : 'translate-y-0 bg-foreground/[0.08]'
            }`}
            style={pressed ? { transitionDelay: `${index * 40}ms` } : undefined}
          >
            {key}
          </span>
        </Fragment>
      ))}
    </div>
  )
}
