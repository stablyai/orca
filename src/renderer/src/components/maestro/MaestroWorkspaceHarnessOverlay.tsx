import { Gauge } from 'lucide-react'
import { useState } from 'react'
import { legacyMaestroTaskProgress } from '../../../../shared/maestro-run-progress'
import { Badge } from '@/components/ui/badge'
import { translate } from '@/i18n/i18n'
import {
  HealthWarning,
  ProgressMeter,
  RunProgressSection,
  TechnicalDisclosure
} from './MaestroRunProgressSections'
import { MaestroStatePip } from './MaestroWindowFrame'
import { MaestroHumanReview, urgentHumanReviewCount } from './MaestroHumanReview'
import type { MaestroHumanReviewResource } from './useMaestroHumanReview'
import type { MaestroRunPanelVisibility } from './maestro-run-panel-visibility'
import {
  availableLegacyRunProgress,
  humanResourceRows,
  humanProgressRows,
  isMaestroRunProgressV2,
  legacyStateLabel,
  LegacyRunProgressSections,
  RUN_PANEL_ICONS,
  RunPanelControl,
  V2_STATE_LABELS,
  type MaestroRunProgressPresentation
} from './maestro-run-progress-presentation'
import { maestroStateTone } from './maestro-window-model'
import { maestroRunTechnicalEntries } from './maestro-run-technical-entries'
import { MaestroRunCompletionSummary } from './MaestroRunCompletionSummary'

type OverlayProps = {
  progress: MaestroRunProgressPresentation
  authorityUnavailable: boolean
  visibility: MaestroRunPanelVisibility
  onVisibilityChange: (visibility: MaestroRunPanelVisibility) => void
  onActivateReference: (reference: string) => boolean
  humanReview: MaestroHumanReviewResource
}

export function MaestroWorkspaceHarnessOverlay(props: OverlayProps): React.JSX.Element {
  const [inspectedReference, setInspectedReference] = useState<string | null>(null)
  const humanProgress = isMaestroRunProgressV2(props.progress) ? props.progress : null
  const legacyProgress = availableLegacyRunProgress(props.progress)
  const title = humanProgress
    ? humanProgress.run.title
    : translate(
        'auto.components.maestro.MaestroWorkspaceHarnessOverlay.legacyRunTitle',
        'Run progress'
      )
  const state = humanProgress
    ? (humanProgress.completion?.state ?? humanProgress.execution.state)
    : legacyProgress
      ? legacyProgress.summary.state
      : 'outcome_unknown'
  const stateLabel = humanProgress
    ? V2_STATE_LABELS[humanProgress.completion?.state ?? humanProgress.execution.state]()
    : legacyProgress
      ? legacyStateLabel(legacyProgress)
      : V2_STATE_LABELS.outcome_unknown()
  const urgent = state === 'blocked' || state === 'input_required' || state === 'outcome_unknown'
  const urgentReviews = urgentHumanReviewCount(props.humanReview.reviews)

  if (props.visibility === 'hidden') {
    return (
      <button
        type="button"
        className="absolute left-3 top-3 z-40 flex max-w-[min(24rem,calc(100%-7rem))] items-center gap-2 rounded-md border border-border bg-card/90 px-2.5 py-1.5 text-left shadow-xs backdrop-blur-md outline-none hover:bg-accent focus-visible:ring-2 focus-visible:ring-ring"
        data-maestro-run-restore-control=""
        aria-label={translate(
          'auto.components.maestro.MaestroWorkspaceHarnessOverlay.restoreRunPanel',
          'Restore Run progress panel'
        )}
        onClick={() => props.onVisibilityChange('compact')}
      >
        <MaestroStatePip tone={maestroStateTone(state)} />
        <span className="truncate text-xs font-medium text-foreground">{title}</span>
        <span className="shrink-0 text-[10px] text-muted-foreground">{stateLabel}</span>
        {urgentReviews > 0 ? (
          <Badge variant="outline" className="shrink-0">
            {translate(
              'auto.components.maestro.MaestroWorkspaceHarnessOverlay.reviewItems',
              '{{value0}} review',
              { value0: urgentReviews }
            )}
          </Badge>
        ) : null}
        {urgent ? <span className="sr-only">{stateLabel}</span> : null}
      </button>
    )
  }

  if (!humanProgress && !legacyProgress) {
    return (
      <aside
        className={`absolute left-3 z-40 rounded-lg border border-border bg-card p-3 text-xs text-muted-foreground shadow-xs ${props.authorityUnavailable ? 'top-24' : 'top-3'}`}
        data-maestro-workspace-harness-overlay=""
        aria-label={translate(
          'auto.components.maestro.MaestroWorkspaceHarnessOverlay.runProgress',
          'Run progress'
        )}
      >
        {translate(
          'auto.components.maestro.MaestroWorkspaceHarnessOverlay.3c305a1143',
          'Run progress is unavailable for this peer.'
        )}
      </aside>
    )
  }

  const legacyTaskProgress = legacyProgress
    ? legacyMaestroTaskProgress(legacyProgress.summary)
    : null
  const completed = humanProgress
    ? humanProgress.execution.completed
    : (legacyTaskProgress?.completed ?? 0)
  const total = humanProgress ? humanProgress.execution.total : (legacyTaskProgress?.total ?? 0)
  const percent = humanProgress
    ? humanProgress.execution.progress_percent
    : legacyTaskProgress?.percent
  const rows = humanProgress ? humanProgressRows(humanProgress) : null
  const resourceRows = humanProgress ? humanResourceRows(humanProgress) : []
  const compactDetail =
    humanProgress?.completion?.summary ??
    rows?.blocked[0]?.detail ??
    rows?.current[0]?.detail ??
    rows?.recent[0]?.detail ??
    rows?.next[0]?.detail
  const activate = (reference: string): void => {
    if (!props.onActivateReference(reference)) {
      setInspectedReference(reference)
    }
  }

  if (props.visibility === 'compact') {
    return (
      <aside
        className={`absolute left-3 z-40 flex w-[min(30rem,calc(100%-6rem))] items-center gap-2 rounded-lg border border-border bg-card/95 px-2.5 py-2 shadow-xs backdrop-blur-md ${props.authorityUnavailable ? 'top-24' : 'top-3'}`}
        data-maestro-workspace-harness-overlay=""
        data-maestro-run-panel-visibility="compact"
        aria-label={translate(
          'auto.components.maestro.MaestroWorkspaceHarnessOverlay.runProgress',
          'Run progress'
        )}
      >
        <MaestroStatePip tone={maestroStateTone(state)} />
        <span className="min-w-0 flex-1">
          <span className="flex min-w-0 items-baseline gap-2">
            <span className="truncate text-xs font-medium text-foreground">{title}</span>
            <span className="shrink-0 text-[10px] text-muted-foreground">
              {completed}/{total}
            </span>
          </span>
          {compactDetail ? (
            <span className="block truncate text-[10px] text-muted-foreground">
              {compactDetail}
            </span>
          ) : null}
        </span>
        <Badge variant="outline" className="shrink-0">
          {stateLabel}
        </Badge>
        {urgentReviews > 0 ? (
          <Badge variant="outline" className="shrink-0">
            {translate(
              'auto.components.maestro.MaestroWorkspaceHarnessOverlay.reviewItems',
              '{{value0}} review',
              { value0: urgentReviews }
            )}
          </Badge>
        ) : null}
        <RunPanelControl
          label={translate(
            'auto.components.maestro.MaestroWorkspaceHarnessOverlay.expandRunPanel',
            'Expand Run panel'
          )}
          icon={RUN_PANEL_ICONS.expand}
          onClick={() => props.onVisibilityChange('expanded')}
        />
        <RunPanelControl
          label={translate(
            'auto.components.maestro.MaestroWorkspaceHarnessOverlay.hideRunPanel',
            'Hide Run panel'
          )}
          icon={RUN_PANEL_ICONS.hide}
          onClick={() => props.onVisibilityChange('hidden')}
        />
      </aside>
    )
  }

  const technicalEntries = maestroRunTechnicalEntries({
    humanProgress,
    legacyProgress,
    inspectedReference
  })

  return (
    <aside
      className={`scrollbar-sleek absolute left-3 z-40 max-h-[min(72%,42rem)] w-[min(27rem,calc(100%-6rem))] overflow-auto rounded-lg border border-border bg-card/95 p-3 shadow-xs backdrop-blur-md ${props.authorityUnavailable ? 'top-24' : 'top-3'}`}
      data-maestro-workspace-harness-overlay=""
      data-maestro-run-panel-visibility="expanded"
      aria-label={translate(
        'auto.components.maestro.MaestroWorkspaceHarnessOverlay.runProgress',
        'Run progress'
      )}
    >
      <header className="flex items-start gap-2">
        <span className="pt-1.5">
          <MaestroStatePip tone={maestroStateTone(state)} />
        </span>
        <span className="min-w-0 flex-1">
          <h2 className="text-pretty text-sm font-semibold leading-5 text-foreground">{title}</h2>
          <span className="text-[11px] text-muted-foreground">{stateLabel}</span>
        </span>
        <RunPanelControl
          label={translate(
            'auto.components.maestro.MaestroWorkspaceHarnessOverlay.compactRunPanel',
            'Compact Run panel'
          )}
          icon={RUN_PANEL_ICONS.compact}
          onClick={() => props.onVisibilityChange('compact')}
        />
        <RunPanelControl
          label={translate(
            'auto.components.maestro.MaestroWorkspaceHarnessOverlay.hideRunPanel',
            'Hide Run panel'
          )}
          icon={RUN_PANEL_ICONS.hide}
          onClick={() => props.onVisibilityChange('hidden')}
        />
      </header>
      <div className="mt-3 space-y-1.5">
        {humanProgress?.deliverables ? (
          <div className="space-y-1.5">
            <div className="flex items-baseline justify-between gap-3 text-[11px]">
              <span className="font-medium text-foreground">
                {translate(
                  'auto.components.maestro.MaestroWorkspaceHarnessOverlay.deliverableReadiness',
                  'Deliverable readiness'
                )}
              </span>
              <span className="tabular-nums text-muted-foreground">
                {humanProgress.deliverables.completed}/{humanProgress.deliverables.total}
              </span>
            </div>
            <ProgressMeter {...humanProgress.deliverables} />
          </div>
        ) : null}
        {humanProgress?.operational_reliability ? (
          <p className="text-[11px] text-muted-foreground">
            <span className="font-medium text-foreground">
              {translate(
                'auto.components.maestro.MaestroWorkspaceHarnessOverlay.reliability',
                'Reliability'
              )}
            </span>{' '}
            {translate(
              'auto.components.maestro.MaestroWorkspaceHarnessOverlay.reliabilitySummary',
              '{{value0}} successful · {{value1}} failed · {{value2}} superseded · {{value3}} unverifiable',
              {
                value0: humanProgress.operational_reliability.successful,
                value1: humanProgress.operational_reliability.failed,
                value2: humanProgress.operational_reliability.superseded,
                value3: humanProgress.operational_reliability.unverifiable
              }
            )}
          </p>
        ) : null}
        <div className="flex items-baseline justify-between gap-3">
          <span className="flex items-center gap-1.5 text-[11px] font-medium text-foreground">
            <Gauge className="size-3.5 text-muted-foreground" />
            {translate(
              'auto.components.maestro.MaestroWorkspaceHarnessOverlay.completedTasks',
              '{{value0}} of {{value1}} tasks',
              { value0: completed, value1: total }
            )}
          </span>
          {percent === undefined ? null : (
            <span className="text-xs font-semibold tabular-nums text-foreground">{percent}%</span>
          )}
        </div>
        <ProgressMeter completed={completed} total={total} percent={percent} />
      </div>
      <div className="mt-3 space-y-3">
        {humanProgress && rows ? (
          <>
            {humanProgress.completion ? (
              <MaestroRunCompletionSummary completion={humanProgress.completion} />
            ) : null}
            <RunProgressSection
              label={translate(
                'auto.components.maestro.MaestroWorkspaceHarnessOverlay.runResources',
                'Run resources'
              )}
              rows={resourceRows}
              onActivate={activate}
            />
            <RunProgressSection
              label={translate(
                'auto.components.maestro.MaestroWorkspaceHarnessOverlay.currentWork',
                'Current work'
              )}
              rows={rows.current}
              onActivate={activate}
            />
            <RunProgressSection
              label={translate(
                'auto.components.maestro.MaestroWorkspaceHarnessOverlay.recentOutcomes',
                'Recent outcomes'
              )}
              rows={rows.recent}
              onActivate={activate}
            />
            <RunProgressSection
              label={translate(
                'auto.components.maestro.MaestroWorkspaceHarnessOverlay.blockers',
                'Blocked'
              )}
              rows={rows.blocked}
              onActivate={activate}
            />
            <RunProgressSection
              label={translate(
                'auto.components.maestro.MaestroWorkspaceHarnessOverlay.nextSteps',
                'Next steps'
              )}
              rows={rows.next}
              onActivate={activate}
            />
            <RunProgressSection
              label={translate(
                'auto.components.maestro.MaestroWorkspaceHarnessOverlay.nestedActivity',
                'Native child activity'
              )}
              rows={rows.nested}
              onActivate={activate}
            />
            {humanProgress.projection_health.state === 'healthy' ? null : (
              <HealthWarning
                label={translate(
                  'auto.components.maestro.MaestroWorkspaceHarnessOverlay.projectionWarning',
                  'Projection'
                )}
                detail={
                  humanProgress.projection_health.warning ??
                  translate(
                    'auto.components.maestro.MaestroWorkspaceHarnessOverlay.projectionNeedsAttention',
                    'Run projection needs attention.'
                  )
                }
                tone="input"
              />
            )}
            {humanProgress.cleanup_health.state === 'clean' ? null : (
              <HealthWarning
                label={translate(
                  'auto.components.maestro.MaestroWorkspaceHarnessOverlay.cleanupWarning',
                  'Cleanup'
                )}
                detail={
                  humanProgress.cleanup_health.warning ??
                  translate(
                    'auto.components.maestro.MaestroWorkspaceHarnessOverlay.cleanupNeedsAttention',
                    '{{value0}} worker resources need attention.',
                    { value0: humanProgress.cleanup_health.count }
                  )
                }
                tone={humanProgress.cleanup_health.state === 'failed' ? 'blocked' : 'input'}
              />
            )}
          </>
        ) : legacyProgress ? (
          <LegacyRunProgressSections progress={legacyProgress} onActivate={activate} />
        ) : null}
        <MaestroHumanReview
          status={props.humanReview.status}
          reviews={props.humanReview.reviews}
          error={props.humanReview.error}
          onRefresh={props.humanReview.refresh}
          onTransition={props.humanReview.transition}
          onFocusBrowser={props.humanReview.focusBrowser}
        />
        <TechnicalDisclosure entries={technicalEntries} open={inspectedReference !== null} />
      </div>
    </aside>
  )
}
