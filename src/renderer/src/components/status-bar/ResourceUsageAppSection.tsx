import React from 'react'
import { ChevronDown, ChevronRight } from 'lucide-react'
import type { AppMemory, UsageValues } from '../../../../shared/process-stats-types'
import { translate } from '@/i18n/i18n'
import {
  ResourceUsageMetricPair,
  ResourceUsageSparkline,
  ROW_TRAILING_GUTTER_CLS
} from './ResourceUsageMetrics'

function AppSubRow({ label, values }: { label: string; values: UsageValues }): React.JSX.Element {
  return (
    <div className="px-3 py-1.5 pl-6 flex items-center justify-between gap-2">
      <span className="text-[11px] text-muted-foreground truncate">{label}</span>
      <div className="flex items-center gap-2 shrink-0">
        <ResourceUsageMetricPair cpu={values.cpu} memory={values.memory} size="small" />
        <span className={ROW_TRAILING_GUTTER_CLS} aria-hidden />
      </div>
    </div>
  )
}

export function ResourceUsageAppSection({
  app,
  isCollapsed,
  onToggle
}: {
  app: AppMemory
  isCollapsed: boolean
  onToggle: () => void
}): React.JSX.Element {
  return (
    <div className="border-t border-border/50">
      <div className="flex items-center">
        <button
          type="button"
          onClick={onToggle}
          className="pl-2 py-2 pr-0.5 transition-colors hover:bg-muted/50"
          aria-label={
            isCollapsed
              ? translate(
                  'auto.components.status.bar.ResourceUsageStatusSegment.e419d27083',
                  'Expand Orca'
                )
              : translate(
                  'auto.components.status.bar.ResourceUsageStatusSegment.53dd5560ae',
                  'Collapse Orca'
                )
          }
          aria-expanded={!isCollapsed}
        >
          {isCollapsed ? (
            <ChevronRight className="h-3 w-3 text-muted-foreground" />
          ) : (
            <ChevronDown className="h-3 w-3 text-muted-foreground" />
          )}
        </button>
        <div className="flex-1 min-w-0 py-2 pr-3 flex items-center justify-between">
          <span className="text-[11px] font-semibold uppercase tracking-wide truncate text-muted-foreground">
            {translate('auto.components.status.bar.ResourceUsageStatusSegment.288a4dd177', 'Orca')}
          </span>
          <div className="flex items-center gap-2 shrink-0">
            <ResourceUsageSparkline samples={app.history} />
            <ResourceUsageMetricPair cpu={app.cpu} memory={app.memory} />
            <span className={ROW_TRAILING_GUTTER_CLS} aria-hidden />
          </div>
        </div>
      </div>
      {!isCollapsed && (
        <div className="border-t border-border/30">
          <AppSubRow
            label={translate(
              'auto.components.status.bar.ResourceUsageStatusSegment.81cd37af99',
              'Main'
            )}
            values={app.main}
          />
          <AppSubRow
            label={translate(
              'auto.components.status.bar.ResourceUsageStatusSegment.d406915b78',
              'Renderer'
            )}
            values={app.renderer}
          />
          {(app.other.cpu > 0 || app.other.memory > 0) && (
            <AppSubRow
              label={translate(
                'auto.components.status.bar.ResourceUsageStatusSegment.0f9e50eb07',
                'Other'
              )}
              values={app.other}
            />
          )}
        </div>
      )}
    </div>
  )
}
