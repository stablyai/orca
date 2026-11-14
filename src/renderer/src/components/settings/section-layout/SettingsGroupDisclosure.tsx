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
  children: React.ReactNode
}

/** Collapsible rows inside a SettingsGroup card, one fixed step in from the card's rows. Search force-opens it so matches remain reachable. */
export function SettingsGroupDisclosure({
  label,
  description,
  forceOpen = false,
  children
}: SettingsGroupDisclosureProps): React.JSX.Element {
  const t = useTranslate()
  const [open, setOpen] = useState(false)
  const expanded = open || forceOpen
  const revealRef = useSettingsTargetReveal<HTMLDivElement>(() => setOpen(true))

  return (
    <div ref={revealRef} data-settings-group-disclosure="" className="border-t border-border">
      <button
        type="button"
        aria-expanded={expanded}
        onClick={() => setOpen((prev) => !prev)}
        // Unsaved edits must remain reachable.
        disabled={forceOpen}
        className="flex min-h-11 w-full items-center gap-2 text-sm font-semibold text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring/50 disabled:cursor-default"
      >
        <ChevronRight
          className={cn(
            'size-3.5 text-muted-foreground transition-transform',
            expanded && 'rotate-90'
          )}
        />
        {label ?? t('auto.components.settings.AppearanceAdvancedDisclosure.advanced', 'Advanced')}
        {description ? (
          <span className="truncate text-xs font-normal text-muted-foreground">{description}</span>
        ) : null}
      </button>
      {/* Stays mounted while collapsed so a settings jump can find and reveal its rows. */}
      <div hidden={!expanded} className={SETTINGS_GROUP_NESTED_INSET_CLASS}>
        {children}
      </div>
    </div>
  )
}
