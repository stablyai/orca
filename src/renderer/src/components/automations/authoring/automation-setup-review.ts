import { toast } from 'sonner'
import { translate } from '@/i18n/i18n'
import { useAppStore } from '@/store/index'
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
import type { ExecutionHostId } from '../../../../../shared/execution-host'

/** Runs create from the automation's base, so approve the orca.yaml there, not the project checkout's. */
export function approveAutomationSetup(
  repoId: string,
  hostId: ExecutionHostId | undefined,
  baseBranch: string | null | undefined
): Promise<HookTrustApproval> {
  const createSource = { kind: 'base' as const, baseBranch: baseBranch?.trim() || undefined }
  return ensureHooksApproved(
    useAppStore.getState(),
    repoId,
    'setup',
    hostId,
    undefined,
    undefined,
    undefined,
    createSource
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
  return content && content.contentHash === automation.setupTrustHash ? null : { content }
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
 * Show the skipped setup commands; approving stores their hash so later runs run them. Nothing
 * runs now, and a declined review leaves the automation unchanged.
 */
export async function reviewAutomationSkippedSetup(
  automation: Automation,
  content: SetupTrustMismatch,
  saveSetupTrustHash: (setupTrustHash: string) => Promise<boolean>
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
  if (await saveSetupTrustHash(approval.approvedContentHash)) {
    toast.success(
      translate(
        'automations.setupTrust.approved',
        'Setup approved. Later runs of this automation will run it.'
      )
    )
  }
}

/**
 * Saving an automation whose last run skipped changed setup re-confirms that setup: the skipped
 * content when the host recorded it, else the repo's current one. Returns the hash to store.
 */
/**
 * A save's setup approval: prompt when the target or setup choice changed, else re-review a skipped run.
 * The hash is stored with `run` so later runs execute only this content.
 */
export async function confirmAutomationSaveSetup(
  context: Pick<AutomationSaveContext, 'local' | 'list'>,
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
  const setupTrustHash =
    trust?.approvedContentHash ??
    (await reconfirmSkippedSetup(
      context,
      trust,
      args.setupDecision,
      args.automation,
      args.hostId,
      args.baseBranch
    ))
  return { trust, setupTrustHash }
}

async function reconfirmSkippedSetup(
  context: Pick<AutomationSaveContext, 'local' | 'list'>,
  trust: HookTrustApproval | null,
  setupDecision: SetupDecision | undefined,
  automation: Automation | null,
  hostId: ExecutionHostId | undefined,
  baseBranch: string | null | undefined
): Promise<string | undefined> {
  // A changed target or setup choice was just confirmed by the regular save prompt.
  if (trust || context.local.targetEdited || setupDecision !== 'run' || !automation) {
    return undefined
  }
  const { editingRowKey } = context.local
  const summary = context.list.visibleRows.find((row) => row.key === editingRowKey)?.usageSummary
  const review = pendingAutomationSetupReviewFromSummary(automation, summary ?? null)
  if (!review) {
    return undefined
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
  return approval.decision === 'run' && approval.approvedContentHash !== automation.setupTrustHash
    ? approval.approvedContentHash
    : undefined
}
