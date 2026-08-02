import React from 'react'
import { CalendarClock, PlayCircle } from 'lucide-react'
import type { ExecutionHostId } from '../../../../shared/execution-host'
import type { AutomationWorkspaceProvenance } from '../../../../shared/types'
import {
  WorktreeCardDetailSection,
  WorktreeCardDetailSectionContent
} from './WorktreeCardDetailSection'
import { DetailHeader, MetadataActionIcon } from './WorktreeCardMetadataControls'
import { translate } from '@/i18n/i18n'
import {
  getAutomationTargetFromHostId,
  listAutomationRunsForTarget,
  listAutomationsForTarget
} from '@/components/automations/automation-host-client'

type WorktreeCardAutomationDetailSectionProps = {
  provenance: AutomationWorkspaceProvenance
  worktreeHostId?: ExecutionHostId
  onOpenAutomation?: (event: React.MouseEvent) => void
  onOpenAutomationRun?: (event: React.MouseEvent) => void
}

type AutomationProvenanceAvailability =
  | { status: 'checking' }
  | { status: 'available'; runAvailable: boolean }
  | { status: 'automation-missing' }
  | { status: 'unavailable' }

export function WorktreeCardAutomationDetailSection({
  provenance,
  worktreeHostId,
  onOpenAutomation,
  onOpenAutomationRun
}: WorktreeCardAutomationDetailSectionProps): React.JSX.Element {
  const [availability, setAvailability] = React.useState<AutomationProvenanceAvailability>({
    status: 'checking'
  })

  React.useEffect(() => {
    let cancelled = false
    async function resolveAvailability(): Promise<void> {
      setAvailability({ status: 'checking' })
      try {
        const target = getAutomationTargetFromHostId(provenance.hostId ?? worktreeHostId)
        const automations = await listAutomationsForTarget(target)
        const automation = automations.find((entry) => entry.id === provenance.automationId)
        if (!automation) {
          if (!cancelled) {
            setAvailability({ status: 'automation-missing' })
          }
          return
        }
        const runs = await listAutomationRunsForTarget(target, provenance.automationId)
        if (!cancelled) {
          setAvailability({
            status: 'available',
            runAvailable: runs.some((run) => run.id === provenance.automationRunId)
          })
        }
      } catch {
        if (!cancelled) {
          setAvailability({ status: 'unavailable' })
        }
      }
    }

    void resolveAvailability()
    return () => {
      cancelled = true
    }
  }, [provenance.automationId, provenance.automationRunId, provenance.hostId, worktreeHostId])

  const canOpenAutomation = availability.status === 'available'
  const canOpenAutomationRun = availability.status === 'available' && availability.runAvailable

  return (
    <WorktreeCardDetailSection>
      <DetailHeader
        icon={<CalendarClock className="size-3 text-muted-foreground" />}
        label={translate('auto.components.sidebar.WorktreeCardMeta.automationHeader', 'Automation')}
        actions={
          <>
            {onOpenAutomation && canOpenAutomation && (
              <MetadataActionIcon
                label={translate(
                  'auto.components.sidebar.WorktreeCardMeta.openAutomation',
                  'Open automation'
                )}
                onClick={onOpenAutomation}
              >
                <CalendarClock className="size-3" />
              </MetadataActionIcon>
            )}
            {onOpenAutomationRun && canOpenAutomationRun && (
              <MetadataActionIcon
                label={translate(
                  'auto.components.sidebar.WorktreeCardMeta.openAutomationRun',
                  'Open run'
                )}
                onClick={onOpenAutomationRun}
              >
                <PlayCircle className="size-3" />
              </MetadataActionIcon>
            )}
          </>
        }
      />
      <WorktreeCardDetailSectionContent className="space-y-1.5">
        <div className="text-[13px] font-semibold leading-snug text-foreground break-words">
          {provenance.automationNameSnapshot}
        </div>
        <div className="text-[11.5px] leading-snug text-muted-foreground break-words">
          {provenance.automationRunTitleSnapshot}
        </div>
        {availability.status === 'checking' ? (
          <div className="text-[11px] leading-snug text-muted-foreground">
            {translate(
              'auto.components.sidebar.WorktreeCardMeta.checkingAutomationAvailability',
              'Checking automation availability...'
            )}
          </div>
        ) : null}
        {availability.status === 'automation-missing' ? (
          <div className="text-[11px] leading-snug text-muted-foreground">
            {translate(
              'auto.components.sidebar.WorktreeCardMeta.automationMissing',
              'Automation no longer available.'
            )}
          </div>
        ) : null}
        {availability.status === 'available' && !availability.runAvailable ? (
          <div className="text-[11px] leading-snug text-muted-foreground">
            {translate(
              'auto.components.sidebar.WorktreeCardMeta.automationRunMissing',
              'Run history no longer available.'
            )}
          </div>
        ) : null}
        {availability.status === 'unavailable' ? (
          <div className="text-[11px] leading-snug text-muted-foreground">
            {translate(
              'auto.components.sidebar.WorktreeCardMeta.automationAvailabilityUnavailable',
              'Automation availability could not be checked.'
            )}
          </div>
        ) : null}
      </WorktreeCardDetailSectionContent>
    </WorktreeCardDetailSection>
  )
}
