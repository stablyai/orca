import type React from 'react'
import { useState } from 'react'
import { ChevronRight } from 'lucide-react'
import { cn } from '@/lib/class-names'
import { useSettingsTargetReveal } from '../section-layout/settings-target-highlight'
import { useTranslate } from '@/i18n/use-translate'

type AppearanceAdvancedDisclosureProps = {
  label?: string
  forceOpen?: boolean
  showTopBorder?: boolean
  className?: string
  contentClassName?: string
  children: React.ReactNode
}

/** A settings jump opens advanced controls so its target stays reachable. */
export function AppearanceAdvancedDisclosure({
  label,
  forceOpen = false,
  showTopBorder = true,
  className,
  contentClassName,
  children
}: AppearanceAdvancedDisclosureProps): React.JSX.Element {
  const t = useTranslate()
  const [open, setOpen] = useState(false)
  const expanded = open || forceOpen
  const revealRef = useSettingsTargetReveal<HTMLDivElement>(() => setOpen(true))

  return (
    <div
      ref={revealRef}
      className={cn('mt-3 pt-2', showTopBorder && 'border-t border-border/50', className)}
    >
      <button
        type="button"
        aria-expanded={expanded}
        onClick={() => setOpen((prev) => !prev)}
        // Unsaved edits must remain reachable.
        disabled={forceOpen}
        className="flex w-full items-center gap-2 py-1 text-sm font-semibold text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring/50 disabled:cursor-default"
      >
        <ChevronRight
          className={cn(
            'size-3.5 text-muted-foreground transition-transform',
            expanded && 'rotate-90'
          )}
        />
        {label ?? t('auto.components.settings.AppearanceAdvancedDisclosure.advanced', 'Advanced')}
      </button>
      {/* Stays mounted while collapsed so a settings jump can find and reveal its rows. */}
      <div hidden={!expanded} className={cn('pt-1', contentClassName)}>
        {children}
      </div>
    </div>
  )
}
