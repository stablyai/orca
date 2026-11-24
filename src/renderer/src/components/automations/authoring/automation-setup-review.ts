import { toast } from 'sonner'
import { translate } from '@/i18n/i18n'
import { useAppStore } from '@/store/index'
import { isDesktopHookRepoTrusted } from '@/runtime/repo-hooks/hook-script-confirmation'
import {
  confirmCreatedWorktreeSetupContent,
  ensureHooksApproved,
  type HookTrustApproval
} from '@/runtime/repo-hooks/ensure-hooks-confirmed'
import type { AutomationSaveContext } from './automation-save-context'
import type { Automation } from '../../../../../shared/automations/automation-definition'
import type { AutomationUsageSummary } from '../../../../../shared/automations/history/automation-usage-summary'
import { getAutomationRunRepoId } from '../../../../../shared/automations/history/automation-run-identity'
import type { SetupDecision, SetupTrustMismatch } from '../../../../../shared/worktree/create-types'
import type { ExecutionHostId } from '../../../../../shared/execution-host/execution-host'

type SetupReviewSaveContext = {
  local: Pick<AutomationSaveContext['local'], 'targetEdited' | 'editingRowKey'>
  list: Pick<AutomationSaveContext['list'], 'visibleRows'>
}

/** Runs create from the automation's base, so approve the orca.yaml there, not the project checkout's. */
export function approveAutomationSetup(
  repoId: string,
  hostId: ExecutionHostId | undefined,
  baseBranch: string | null | undefined
): Promise<HookTrustApproval> {
  const createSource = { kind: 'base' as const, baseBranch: baseBranch?.trim() || undefined }
  return ensureHooksApproved(
    useAppStore.getState,
    repoId,
    'setup',
    hostId,
    undefined,
    undefined,
    undefined,
    createSource,
    'automation'
  )
}

/** A skipped setup still waiting for approval; null once the automation approves that content. */
export type PendingAutomationSetupReview = { content: SetupTrustMismatch | null }

export function pendingAutomationSetupReview(
  automation: Pick<Automation, 'setupDecision' | 'setupTrustHash' | 'workspaceMode'>,
  skipped: { skipped: boolean; content?: SetupTrustMismatch | null }
): PendingAutomationSetupReview | null {
  if (
    !skipped.skipped ||
    automation.workspaceMode !== 'new_per_run' ||
    automation.setupDecision !== 'run'
  ) {
    return null
  }
  const content = skipped.content ?? null
  // Why: hosts only skip for a stored hash, so with none the skipped content has since been trusted.
  return !automation.setupTrustHash || content?.contentHash === automation.setupTrustHash
    ? null
    : { content }
}

export function pendingAutomationSetupReviewFromSummary(
  automation: Pick<Automation, 'setupDecision' | 'setupTrustHash' | 'workspaceMode'>,
  summary: AutomationUsageSummary | null
): PendingAutomationSetupReview | null {
  return pendingAutomationSetupReview(automation, {
    skipped: summary?.lastRunSetupSkipped === true,
    content: summary?.lastRunSetupSkippedContent
  })
}

/**
 * Show the skipped setup commands; trusting the repo lets later runs use its setup. Nothing
 * runs now, and a declined review leaves the automation unchanged.
 */
export async function reviewAutomationSkippedSetup(
  automation: Pick<Automation, 'projectId' | 'runContext'>,
  content: SetupTrustMismatch,
  saveSetupTrustHash: (setupTrustHash: string | undefined) => Promise<boolean>
): Promise<void> {
  const approval = await confirmCreatedWorktreeSetupContent(
    useAppStore.getState,
    getAutomationRunRepoId(automation),
    content.scriptContent,
    automation.runContext?.hostId,
    'automation'
  )
  if (approval.decision !== 'run' || approval.approvedContentHash === undefined) {
    return
  }
  if (
    await saveSetupTrustHash(
      automationSetupPin(getAutomationRunRepoId(automation), approval.approvedContentHash)
    )
  ) {
    toast.success(
      translate(
        'automations.setupTrust.approved',
        'Setup approved. Later runs of this automation will run it.'
      )
    )
  }
}

/**
 * A save's setup approval: prompt when the target or setup choice changed, else re-review a skipped run.
 * Approvals that don't trust the repo, such as empty setup or a project on two hosts, keep a content pin.
 */
export async function confirmAutomationSaveSetup(
  context: SetupReviewSaveContext,
  args: {
    prompt: boolean
    repoId: string
    hostId: ExecutionHostId | undefined
    /** The base this save persists, which an edit may have just changed. */
    baseBranch: string | null | undefined
    setupDecision: SetupDecision | undefined
    automation: Automation | null
  }
): Promise<{ trust: HookTrustApproval | null; setupTrustHash: string | undefined }> {
  const trust = args.prompt
    ? await approveAutomationSetup(args.repoId, args.hostId, args.baseBranch)
    : null
  const reviewTrust = trust
    ? null
    : await reconfirmSkippedSetup(
        context,
        args.setupDecision,
        args.automation,
        args.hostId,
        args.baseBranch
      )
  const approval = trust ?? reviewTrust
  return {
    trust: approval,
    setupTrustHash: automationSetupPin(args.repoId, approval?.approvedContentHash)
  }
}

/** Only a repo trusted for automations runs later setup unpinned; any other approval keeps its content pin. */
function automationSetupPin(repoId: string, approvedContentHash: string | undefined) {
  return isDesktopHookRepoTrusted(useAppStore.getState(), repoId, 'automation')
    ? undefined
    : approvedContentHash
}

/**
 * Saving an automation whose last run skipped changed setup re-confirms that setup: the skipped
 * content when the host recorded it, else the content at the automation's base.
 */
async function reconfirmSkippedSetup(
  context: SetupReviewSaveContext,
  setupDecision: SetupDecision | undefined,
  automation: Automation | null,
  hostId: ExecutionHostId | undefined,
  baseBranch: string | null | undefined
): Promise<HookTrustApproval | null> {
  // A changed target or setup choice was just confirmed by the regular save prompt.
  if (context.local.targetEdited || setupDecision !== 'run' || !automation) {
    return null
  }
  const { editingRowKey } = context.local
  const summary = context.list.visibleRows.find((row) => row.key === editingRowKey)?.usageSummary
  const review = pendingAutomationSetupReviewFromSummary(automation, summary ?? null)
  if (!review) {
    return null
  }
  const repoId = getAutomationRunRepoId(automation)
  const approval = review.content
    ? await confirmCreatedWorktreeSetupContent(
        useAppStore.getState,
        repoId,
        review.content.scriptContent,
        hostId,
        'automation'
      )
    : await approveAutomationSetup(repoId, hostId, baseBranch)
  return approval.decision === 'run' ? approval : null
}
