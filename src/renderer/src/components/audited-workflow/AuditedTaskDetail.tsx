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
import {
  getStartTriageErrorMessage,
  isRetryableTriageReasonCode,
  isRetryableWorktreeReasonCode,
  needsExplicitWorktreeProvisioning
} from './audited-workflow-error-messages'
import { getWorktreeErrorMessage } from './audited-worktree-error-messages'
import { AuditedExecutionControls } from './AuditedExecutionControls'
import { AuditedPlanReviewPanel } from './AuditedPlanReviewPanel'
import { AuditedCodeAuditPanel } from './AuditedCodeAuditPanel'
import { AuditedCommitPanel } from './AuditedCommitPanel'
import { AuditedPublishPanel } from './AuditedPublishPanel'
import { AuditedLandPanel } from './AuditedLandPanel'
import { AuditedTriageApiKeyDialog } from './AuditedTriageApiKeyDialog'
import { useAppStore } from '@/store'
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
  const startAuditedTaskTriage = useAppStore((s) => s.startAuditedTaskTriage)
  const retryAuditedTaskTriage = useAppStore((s) => s.retryAuditedTaskTriage)
  const provisionAuditedTaskWorktree = useAppStore((s) => s.provisionAuditedTaskWorktree)
  const triageStartingTaskId = useAppStore((s) => s.auditedTriageStartingTaskId)
  const isStartingTriage = triageStartingTaskId === task.taskId
  const isTriageRunning = task.state === 'triaging' || isStartingTriage
  // Why a pending flag rather than task.state: the task deliberately stays
  // `selected` while its worktree is provisioned (no new lifecycle state), so
  // state alone cannot express "preparing".
  const isPreparingWorktree = isStartingTriage && !task.worktreeReady

  const [apiKeyDialogOpen, setApiKeyDialogOpen] = useState(false)
  const [apiKeyConfigured, setApiKeyConfigured] = useState(false)
  const [apiKeyDraft, setApiKeyDraft] = useState('')
  const [apiKeyPending, setApiKeyPending] = useState(false)

  const handleStartTriage = async (): Promise<void> => {
    await startAuditedTaskTriage(task.taskId)
  }

  const handleRetryTriage = async (): Promise<void> => {
    await retryAuditedTaskTriage(task.taskId)
  }

  // Recovery only prepares the worktree and restores the prior state. It never
  // chains into Start Triage — the provider runs only on an explicit click.
  const handleProvisionWorktree = async (): Promise<void> => {
    await provisionAuditedTaskWorktree(task.taskId)
  }

  const openApiKeyDialog = async (): Promise<void> => {
    setApiKeyDraft('')
    try {
      const status = await window.api.auditedWorkflow.getTriageProviderStatus()
      setApiKeyConfigured(status.configured)
    } catch {
      setApiKeyConfigured(false)
    }
    setApiKeyDialogOpen(true)
  }

  const handleSaveApiKey = async (): Promise<void> => {
    setApiKeyPending(true)
    try {
      const status = await window.api.auditedWorkflow.saveTriageApiKey({ apiKey: apiKeyDraft })
      setApiKeyConfigured(status.configured)
      setApiKeyDraft('')
      setApiKeyDialogOpen(false)
    } catch {
      // Why: the IPC handler is written to always resolve with a safe
      // { configured } status, never reject — this catch is defense-in-depth
      // so a genuinely unexpected rejection (e.g. a preload-layer failure)
      // can never surface as an unhandled promise rejection. Leave the
      // dialog open with its current configured/draft state on this path.
    } finally {
      setApiKeyPending(false)
    }
  }

  const handleClearApiKey = async (): Promise<void> => {
    setApiKeyPending(true)
    try {
      const status = await window.api.auditedWorkflow.clearTriageApiKey()
      setApiKeyConfigured(status.configured)
      setApiKeyDraft('')
      setApiKeyDialogOpen(false)
    } catch {
      // Why: same rationale as handleSaveApiKey's catch — defense-in-depth
      // against an unexpected rejection becoming an unhandled promise
      // rejection in the renderer.
    } finally {
      setApiKeyPending(false)
    }
  }

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

      {task.state === 'selected' || task.state === 'triaging' ? (
        <div className="mt-4 flex items-center gap-3">
          <Button size="sm" onClick={handleStartTriage} disabled={isTriageRunning}>
            {isPreparingWorktree
              ? translate(
                  'auto.components.auditedWorkflow.AuditedTaskDetail.preparingWorktree',
                  'Preparing worktree…'
                )
              : isTriageRunning
                ? translate(
                    'auto.components.auditedWorkflow.AuditedTaskDetail.triageRunning',
                    'Triage running…'
                  )
                : translate(
                    'auto.components.auditedWorkflow.AuditedTaskDetail.startTriage',
                    'Start Triage'
                  )}
          </Button>
        </div>
      ) : null}

      {task.state === 'planning' || task.state === 'ready_to_implement' ? (
        <div className="mt-4 rounded-lg border border-border bg-muted/30 p-3 text-sm">
          {translate(
            'auto.components.auditedWorkflow.AuditedTaskDetail.triageSucceeded',
            'Triage decided:'
          )}{' '}
          <span className="font-medium capitalize">{task.triageDecision}</span>
        </div>
      ) : null}

      <AuditedExecutionControls task={task} />

      <AuditedPlanReviewPanel task={task} />

      <AuditedCodeAuditPanel task={task} />
      <AuditedCommitPanel task={task} />
      <AuditedPublishPanel task={task} />
      <AuditedLandPanel task={task} />

      {task.state === 'blocked' && task.worktreeReasonCode ? (
        <div className="mt-4 flex flex-col gap-2 rounded-lg border border-destructive/30 bg-destructive/5 p-3 text-sm text-destructive">
          <span>{getWorktreeErrorMessage(task.worktreeReasonCode)}</span>
          {isRetryableWorktreeReasonCode(task.worktreeReasonCode) ||
          needsExplicitWorktreeProvisioning(task.worktreeReasonCode) ? (
            <div className="flex items-center gap-2">
              <Button
                size="sm"
                variant="outline"
                onClick={() => void handleProvisionWorktree()}
                disabled={isStartingTriage}
              >
                {needsExplicitWorktreeProvisioning(task.worktreeReasonCode)
                  ? translate(
                      'auto.components.auditedWorkflow.AuditedTaskDetail.provisionWorktree',
                      'Provision Worktree'
                    )
                  : translate(
                      'auto.components.auditedWorkflow.AuditedTaskDetail.retryWorktree',
                      'Retry'
                    )}
              </Button>
            </div>
          ) : null}
        </div>
      ) : task.state === 'blocked' && task.triageBlockedReasonCode ? (
        <div className="mt-4 flex flex-col gap-2 rounded-lg border border-destructive/30 bg-destructive/5 p-3 text-sm text-destructive">
          <span>{getStartTriageErrorMessage(task.triageBlockedReasonCode)}</span>
          <div className="flex items-center gap-2">
            {isRetryableTriageReasonCode(task.triageBlockedReasonCode) ? (
              <Button
                size="sm"
                variant="outline"
                onClick={handleRetryTriage}
                disabled={isTriageRunning}
              >
                {translate(
                  'auto.components.auditedWorkflow.AuditedTaskDetail.retryTriage',
                  'Retry'
                )}
              </Button>
            ) : null}
            {task.triageBlockedReasonCode === 'provider_unavailable' ? (
              <Button size="sm" variant="outline" onClick={() => void openApiKeyDialog()}>
                {translate(
                  'auto.components.auditedWorkflow.AuditedTaskDetail.configureApiKey',
                  'Configure API Key'
                )}
              </Button>
            ) : null}
          </div>
        </div>
      ) : task.state === 'blocked' && task.blockedReasonCode ? (
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

      <AuditedTriageApiKeyDialog
        open={apiKeyDialogOpen}
        configured={apiKeyConfigured}
        apiKeyDraft={apiKeyDraft}
        pending={apiKeyPending}
        onOpenChange={setApiKeyDialogOpen}
        onApiKeyDraftChange={setApiKeyDraft}
        onSave={() => void handleSaveApiKey()}
        onClear={() => void handleClearApiKey()}
      />
    </div>
  )
}
