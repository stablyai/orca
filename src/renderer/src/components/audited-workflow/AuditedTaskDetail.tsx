// Detail pane for the selected audited task. Phase 1 renders state/metadata
// and, in dev builds only, a manual transition control for exercising the
// state machine end to end without any model invocation or Git mutation
// (see ipc/audited-workflow-dev-transitions.ts).
import { useState } from 'react'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue
} from '@/components/ui/select'
import type { AuditedTaskStatusProjection } from '../../../../shared/audited-workflow-types'
import { getAuditedTaskBadgeTone, getAuditedTaskStateLabel } from './audited-task-row-state'
import { translate } from '@/i18n/i18n'

// Mirrors DEV_TRANSITION_COMMANDS in ipc/audited-workflow-dev-transitions.ts.
// Kept as a separate list (not imported from main) so this file has no
// dependency on Electron-main modules.
const DEV_TRANSITION_COMMANDS = [
  'select',
  'triage',
  'triageAutoPlan',
  'triageAutoDirect',
  'triageBlock',
  'planComplete',
  'planReviewApprove',
  'planReviewFixesRequested',
  'planReviewBlock',
  'revisePlan',
  'implement',
  'implementComplete',
  'implementBlock',
  'codeAuditApprove',
  'codeAuditFixesRequested',
  'codeAuditBlock',
  'fix',
  'commitAuthorize',
  'commitComplete',
  'commitBlock',
  'land',
  'landSucceed',
  'landRefuse',
  'blockFromInvariantViolation',
  'retry',
  'resumeAttempt',
  'cancel'
] as const

const BADGE_TONE_VARIANT: Record<
  ReturnType<typeof getAuditedTaskBadgeTone>,
  'secondary' | 'destructive' | 'outline' | 'default'
> = {
  neutral: 'outline',
  progress: 'secondary',
  blocked: 'destructive',
  success: 'default'
}

type AuditedTaskDetailProps = {
  task: AuditedTaskStatusProjection
}

export function AuditedTaskDetail({ task }: AuditedTaskDetailProps): React.JSX.Element {
  const isDevBuild =
    typeof window !== 'undefined' && Boolean(window.api.auditedWorkflow?.devTransition)
  const [devCommand, setDevCommand] = useState<(typeof DEV_TRANSITION_COMMANDS)[number]>('triage')
  const [devError, setDevError] = useState<string | null>(null)
  const [applying, setApplying] = useState(false)

  const handleApplyDevTransition = async (): Promise<void> => {
    if (!window.api.auditedWorkflow?.devTransition) {
      return
    }
    setApplying(true)
    setDevError(null)
    try {
      const result = await window.api.auditedWorkflow.devTransition({
        taskId: task.taskId,
        command: devCommand
      })
      if (!result.applied) {
        setDevError(result.reasonCode ?? 'illegal_transition')
      }
    } catch (err) {
      setDevError(err instanceof Error ? err.message : String(err))
    } finally {
      setApplying(false)
    }
  }

  return (
    <div className="flex h-full min-h-0 flex-col overflow-y-auto p-5 scrollbar-sleek">
      <div className="mb-4 flex items-start justify-between gap-3">
        <div className="min-w-0">
          <h2 className="truncate text-base font-semibold text-foreground">{task.title}</h2>
          <p className="mt-0.5 text-xs text-muted-foreground">{task.taskId}</p>
        </div>
        <Badge variant={BADGE_TONE_VARIANT[getAuditedTaskBadgeTone(task.state)]}>
          {getAuditedTaskStateLabel(task.state)}
        </Badge>
      </div>

      <div className="grid grid-cols-2 gap-4 rounded-lg border border-border p-4 text-sm">
        <div>
          <div className="text-[11px] font-medium uppercase text-muted-foreground">
            {translate('auto.components.auditedWorkflow.AuditedTaskDetail.risk', 'Risk')}
          </div>
          <div className="mt-1 font-medium capitalize">{task.risk}</div>
        </div>
        <div>
          <div className="text-[11px] font-medium uppercase text-muted-foreground">
            {translate('auto.components.auditedWorkflow.AuditedTaskDetail.source', 'Source')}
          </div>
          <div className="mt-1 font-medium capitalize">{task.source}</div>
        </div>
        <div>
          <div className="text-[11px] font-medium uppercase text-muted-foreground">
            {translate('auto.components.auditedWorkflow.AuditedTaskDetail.planRound', 'Plan Round')}
          </div>
          <div className="mt-1 font-medium">{task.planRound} / 3</div>
        </div>
        <div>
          <div className="text-[11px] font-medium uppercase text-muted-foreground">
            {translate('auto.components.auditedWorkflow.AuditedTaskDetail.fixRound', 'Fix Round')}
          </div>
          <div className="mt-1 font-medium">{task.fixRound} / 3</div>
        </div>
      </div>

      {task.state === 'blocked' && task.blockedReasonCode ? (
        <div className="mt-4 rounded-lg border border-destructive/30 bg-destructive/5 p-3 text-sm text-destructive">
          {translate('auto.components.auditedWorkflow.AuditedTaskDetail.blockedReason', 'Blocked:')}{' '}
          {task.blockedReasonCode}
        </div>
      ) : null}

      {isDevBuild ? (
        <div className="mt-6 rounded-lg border border-amber-500/30 bg-amber-500/5 p-4">
          <div className="mb-2 text-[11px] font-medium uppercase text-amber-700 dark:text-amber-400">
            {translate(
              'auto.components.auditedWorkflow.AuditedTaskDetail.devOnly',
              'Dev-only manual transition'
            )}
          </div>
          <div className="flex items-center gap-2">
            <Select
              value={devCommand}
              onValueChange={(v) => setDevCommand(v as (typeof DEV_TRANSITION_COMMANDS)[number])}
            >
              <SelectTrigger className="w-56">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {DEV_TRANSITION_COMMANDS.map((command) => (
                  <SelectItem key={command} value={command}>
                    {command}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
            <Button size="sm" onClick={handleApplyDevTransition} disabled={applying}>
              {translate('auto.components.auditedWorkflow.AuditedTaskDetail.apply', 'Apply')}
            </Button>
          </div>
          {devError ? <p className="mt-2 text-xs text-destructive">{devError}</p> : null}
        </div>
      ) : null}
    </div>
  )
}
