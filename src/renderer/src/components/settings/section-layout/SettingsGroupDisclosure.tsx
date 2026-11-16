import type React from 'react'
import { useState } from 'react'
import { ChevronRight } from 'lucide-react'
import { cn } from '@/lib/class-names'
import { useSettingsTargetReveal } from '../section-layout/settings-target-highlight'
import { useTranslate } from '@/i18n/use-translate'
import { SETTINGS_GROUP_NESTED_INSET_CLASS } from './SettingsGroup'

type SettingsGroupDisclosureProps = {
  label?: string
  /** A muted hint after the label naming what the disclosure holds. */
  description?: string
  forceOpen?: boolean
  /** Owns the open state when set; a click or a settings jump reports through onOpenChange. */
  open?: boolean
  onOpenChange?: (open: boolean) => void
  /** Lines its rows up with the card's other rows instead of one step in. */
  flush?: boolean
  children: React.ReactNode
}

/** Collapsible rows inside a SettingsGroup card, one fixed step in from the card's rows. Search force-opens it so matches remain reachable. */
export function SettingsGroupDisclosure({
  label,
  description,
  forceOpen = false,
  open: controlledOpen,
  onOpenChange,
  flush = false,
  children
}: SettingsGroupDisclosureProps): React.JSX.Element {
  const t = useTranslate()
  const [ownOpen, setOwnOpen] = useState(false)
  const open = controlledOpen ?? ownOpen
  const setOpen = (next: boolean): void => {
    if (controlledOpen === undefined) {
      setOwnOpen(next)
    }
    onOpenChange?.(next)
  }
  const expanded = open || forceOpen
  const revealRef = useSettingsTargetReveal<HTMLDivElement>(() => setOpen(true))

  return (
    <div ref={revealRef} data-settings-group-disclosure="" className="border-t border-border">
      <button
        type="button"
        aria-expanded={expanded}
        onClick={() => setOpen(!open)}
        // Unsaved edits must remain reachable.
        disabled={forceOpen}
        className="flex min-h-11 w-full items-center gap-2 text-left text-sm font-semibold text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring/50 disabled:cursor-default"
      >
        <ChevronRight
          className={cn(
            'size-3.5 shrink-0 text-muted-foreground transition-transform',
            expanded && 'rotate-90'
          )}
        />
        {/* A description too long for the line wraps under the label instead of being cut off. */}
        <span className="flex min-w-0 flex-wrap items-baseline gap-x-2 gap-y-0.5 py-1.5">
          <span>
            {label ??
              t('auto.components.settings.AppearanceAdvancedDisclosure.advanced', 'Advanced')}
          </span>
          {description ? (
            <span className="text-xs font-normal text-muted-foreground">{description}</span>
          ) : null}
        </span>
      </button>
      {/* Stays mounted while collapsed so a settings jump can find and reveal its rows. */}
      <div hidden={!expanded} className={flush ? undefined : SETTINGS_GROUP_NESTED_INSET_CLASS}>
        {children}
      </div>
    </div>
  )
}
