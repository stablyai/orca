import React from 'react'
import { TriangleAlert, X } from 'lucide-react'
import { translate } from '@/i18n/i18n'

export function AutomationListStatusCell({
  enabled,
  movedToDistro = null,
  needsMigration = false,
  setupSkipped = false
}: {
  enabled: boolean
  /** A moved project's local copy: the host runs it, never this computer. */
  movedToDistro?: string | null
  /** A copy its host's Orca server now serves: it runs only once migrated. */
  needsMigration?: boolean
  /** The last run skipped setup whose commands changed and still need approval. */
  setupSkipped?: boolean
}): React.JSX.Element {
  if (movedToDistro) {
    const label = translate(
      'sidebar.wslMoved.automationRunsOnHost',
      'Runs on the {{distro}} host',
      { distro: movedToDistro }
    )
    return (
      <span className="min-w-0 truncate text-muted-foreground" title={label}>
        {label}
      </span>
    )
  }
  if (enabled && needsMigration) {
    const label = translate(
      'auto.components.automations.AutomationDetail.needsMigration',
      'Needs migration'
    )
    return (
      <span className="min-w-0 line-clamp-2 leading-tight text-muted-foreground" title={label}>
        {label}
      </span>
    )
  }
  if (enabled && setupSkipped) {
    return (
      <span
        className="inline-flex min-w-0 items-center gap-1 truncate text-status-warning-text"
        title={translate(
          'automations.setupTrust.listSkippedTitle',
          "The last run skipped setup because its branch's orca.yaml setup commands changed. Review them from the actions menu."
        )}
      >
        <TriangleAlert className="size-3.5 shrink-0" />
        {translate('automations.setupTrust.listSkipped', 'Setup skipped')}
      </span>
    )
  }
  if (enabled) {
    return (
      <span className="inline-flex min-w-0 items-center gap-1 truncate text-muted-foreground">
        <span className="size-1.5 shrink-0 rounded-full bg-foreground" />
        {translate('auto.components.automations.AutomationDetail.eaa02014f8', 'Enabled')}
      </span>
    )
  }
  return (
    <span className="inline-flex min-w-0 items-center gap-1 truncate text-muted-foreground">
      <X className="size-3.5 shrink-0" />
      {translate('auto.components.automations.AutomationDetail.b09b2384fd', 'Paused')}
    </span>
  )
}
