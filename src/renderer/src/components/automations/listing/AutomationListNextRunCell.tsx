import React from 'react'
import { TriangleAlert } from 'lucide-react'
import { useTranslate } from '@/i18n/use-translate'
import { cn } from '@/lib/class-names'

// Why: a direct grid item so truncate clips; pr-1 widens the 12px column gap to 16px before Last run.
const CELL_CLASS = 'min-w-0 truncate pr-1'

/** Next run, or why there isn't one: paused, moved, needs migration, or setup awaiting review. */
export function AutomationListNextRunCell({
  enabled,
  nextRunLabel,
  nextRunTitle,
  movedToDistro = null,
  needsMigration = false,
  setupSkipped = false
}: {
  enabled: boolean
  nextRunLabel: string
  /** The full date behind the compact label. */
  nextRunTitle?: string
  /** A moved project's local copy: the host runs it, never this computer. */
  movedToDistro?: string | null
  /** A copy its host's Orca server now serves: it runs only once migrated. */
  needsMigration?: boolean
  /** The last run skipped setup whose commands changed and still need approval. */
  setupSkipped?: boolean
}): React.JSX.Element {
  const t = useTranslate()
  if (movedToDistro) {
    const label = t('sidebar.wslMoved.automationRunsOnHost', 'Runs on the {{distro}} host', {
      distro: movedToDistro
    })
    return (
      <span className={cn(CELL_CLASS, 'text-muted-foreground')} title={label}>
        {label}
      </span>
    )
  }
  if (!enabled) {
    return (
      <span className={cn(CELL_CLASS, 'inline-flex items-center gap-1.5 text-muted-foreground')}>
        <span
          aria-hidden="true"
          className="size-1.5 shrink-0 rounded-full border border-muted-foreground"
        />
        {t('auto.components.automations.AutomationDetail.b09b2384fd', 'Paused')}
      </span>
    )
  }
  if (needsMigration) {
    const label = t(
      'auto.components.automations.AutomationDetail.needsMigration',
      'Needs migration'
    )
    return (
      <span className={cn(CELL_CLASS, 'text-status-warning-text')} title={label}>
        {label}
      </span>
    )
  }
  if (setupSkipped) {
    return (
      <span
        className={cn(CELL_CLASS, 'inline-flex items-center gap-1 text-status-warning-text')}
        title={t(
          'automations.setupTrust.listSkippedTitle',
          "The last run skipped setup because its branch's orca.yaml setup commands changed. Review them from the actions menu."
        )}
      >
        <TriangleAlert className="size-3.5 shrink-0" />
        {t('automations.setupTrust.listSkipped', 'Setup skipped')}
      </span>
    )
  }
  return (
    <span
      className={cn(CELL_CLASS, 'tabular-nums text-muted-foreground')}
      title={nextRunTitle ?? nextRunLabel}
    >
      {nextRunLabel}
    </span>
  )
}
