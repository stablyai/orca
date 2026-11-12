import { findHookRepo, hookRepoOwnerHostId } from './hook-owner-resolution'
import { projectGroupHookTrustKey } from '../../../../shared/workspace-hook-owner'
import type { AppState } from '@/store/types'
import type { OrcaHooks } from '../../../../shared/orca-yaml-hook-types'
import { resolveHookCommandSourcePolicy } from '../../../../shared/hook-command-source-policy'
import { getSetupTrustContent } from '../../../../shared/orca-hook-setup-config'
import {
  canUseRepoWideTrust,
  isOrcaHookContentApproved
} from '../../../../shared/orca-hook-trust-entries'
import { hashOrcaHookScript } from './orca-hook-trust'
import type { OrcaHookTrustKind } from '../../../../shared/orca-hook-trust-entries'
import { getVmRecipeTrustContent } from './vm-recipe-trust-content'
import { getIssueCommandTrustContent, isUserOwnedIssueCommand } from './issue-command-trust-content'
import {
  checkRuntimeHooks,
  checkRuntimeGroupHooks,
  readRuntimeIssueCommand,
  type IssueCommandReadResult
} from '@/runtime/repo-hooks/runtime-hooks-client'
import { MODAL_DISMISSED_KEY } from '@/store/slices/ui/modal-slot-dismissal'
import { getRepoExecutionHostId, type ExecutionHostId } from '../../../../shared/execution-host'

const NEVER_CANCEL_TRUST_CHECK = (): boolean => false

// Serialize the singleton modal callback so overlapping worktree actions cannot replace it.
let trustPromptChain: Promise<unknown> = Promise.resolve()

function enqueueTrustPrompt<T>(task: () => Promise<T>): Promise<T> {
  const next = trustPromptChain.then(task, task)
  trustPromptChain = next.catch(() => undefined)
  return next
}

export function __resetTrustPromptChainForTests(): void {
  trustPromptChain = Promise.resolve()
}

/** A run carries the approved content's hash (empty content included) unless the whole repo is trusted. */
export type HookTrustApproval = { decision: 'run' | 'skip'; approvedContentHash?: string }

const SKIP: HookTrustApproval = { decision: 'skip' }
const RUN_ANY: HookTrustApproval = { decision: 'run' }

async function confirmScriptContent(
  state: AppState,
  repoId: string,
  scriptKind: OrcaHookTrustKind,
  scriptContent: string,
  hostId?: ExecutionHostId,
  isCancelled: () => boolean = NEVER_CANCEL_TRUST_CHECK,
  signal?: AbortSignal,
  skippedSetupReview?: SkippedSetupReview
): Promise<HookTrustApproval> {
  if (isCancelled() || signal?.aborted) {
    return SKIP
  }
  if (canUseRepoWideTrust(state.trustedOrcaHooks, state.repos, repoId)) {
    return RUN_ANY
  }

  const contentHash = await hashOrcaHookScript(scriptContent)
  if (isCancelled() || signal?.aborted) {
    return SKIP
  }
  const approved: HookTrustApproval = { decision: 'run', approvedContentHash: contentHash }
  const existingHash = state.trustedOrcaHooks[repoId]?.[scriptKind]?.contentHash
  if (
    !scriptContent ||
    isOrcaHookContentApproved(state.trustedOrcaHooks, repoId, scriptKind, contentHash)
  ) {
    return approved
  }

  const repo = findHookRepo(state, repoId, hostId)
  const repoName = repo?.displayName ?? 'this repository'
  const previouslyApproved = Boolean(existingHash)

  const decision = await new Promise<'run' | 'skip'>((resolve) => {
    let settled = false
    const settle = (decision: 'run' | 'skip'): void => {
      if (settled) {
        return
      }
      settled = true
      signal?.removeEventListener('abort', cancel)
      resolve(decision)
    }
    const cancel = (): void => {
      // Eviction settles first, so an abort can only close this prompt.
      if (settled) {
        return
      }
      settle('skip')
      state.closeModal()
    }
    signal?.addEventListener('abort', cancel, { once: true })
    state.openModal('confirm-orca-yaml-hooks', {
      repoId,
      repoName,
      scriptKind,
      scriptContent,
      contentHash,
      previouslyApproved,
      ...(skippedSetupReview ? { skippedSetupReview } : {}),
      onResolve: settle,
      // Why: eviction must fail closed without stranding the singleton trust queue.
      [MODAL_DISMISSED_KEY]: () => settle('skip')
    })
  })
  return decision === 'run' ? approved : SKIP
}

async function confirmIssueCommandReadResult(
  state: AppState,
  repoId: string,
  hostId: ExecutionHostId,
  result: IssueCommandReadResult,
  isCancelled: () => boolean = NEVER_CANCEL_TRUST_CHECK
): Promise<'run' | 'skip'> {
  if (isCancelled()) {
    return 'skip'
  }
  if (isUserOwnedIssueCommand(result)) {
    return 'run'
  }
  if (result.status === 'error') {
    return 'skip'
  }
  const approval = await confirmScriptContent(
    state,
    repoId,
    'issueCommand',
    getIssueCommandTrustContent(result),
    hostId,
    isCancelled
  )
  return approval.decision
}

export type ConfirmedRuntimeIssueCommand = {
  result: IssueCommandReadResult
  template: string
  trustDecision: 'run' | 'skip'
}

function confirmRuntimeIssueCommandRead(
  state: AppState,
  repoId: string,
  hostId: ExecutionHostId,
  result: IssueCommandReadResult,
  isCancelled: () => boolean = NEVER_CANCEL_TRUST_CHECK
): Promise<ConfirmedRuntimeIssueCommand> {
  return enqueueTrustPrompt(async () => ({
    result,
    template: getIssueCommandTrustContent(result),
    trustDecision: await confirmIssueCommandReadResult(state, repoId, hostId, result, isCancelled)
  }))
}

export async function readAndConfirmRuntimeIssueCommand(
  state: AppState,
  repoId: string,
  hostId: ExecutionHostId,
  isCancelled: () => boolean = NEVER_CANCEL_TRUST_CHECK
): Promise<ConfirmedRuntimeIssueCommand> {
  let result: IssueCommandReadResult
  try {
    // Creating a workspace is a user act: it may start the repo's stopped WSL distro.
    result = await readRuntimeIssueCommand(hookRepoOwnerHostId(state, repoId, hostId), repoId, {
      wakeWslDistro: true
    })
  } catch {
    result = {
      status: 'error',
      localContent: null,
      sharedContent: null,
      effectiveContent: null,
      localFilePath: '',
      source: 'none'
    }
  }
  return confirmRuntimeIssueCommandRead(state, repoId, hostId, result, isCancelled)
}

export async function ensureHooksConfirmed(
  ...args: Parameters<typeof ensureHooksApproved>
): Promise<'run' | 'skip'> {
  return (await ensureHooksApproved(...args)).decision
}

/** Which skipped setup the user is reviewing; picks the dialog copy. */
export type SkippedSetupReview = 'created-branch' | 'automation'

/**
 * Re-prompt with setup content that a create or automation run skipped because it differs from
 * what was approved. Approving adds it to the repo's approved setup history.
 */
export function confirmCreatedWorktreeSetupContent(
  getState: () => AppState,
  repoId: string,
  scriptContent: string,
  hostId?: ExecutionHostId,
  review: SkippedSetupReview = 'created-branch'
): Promise<HookTrustApproval> {
  return enqueueTrustPrompt(async () => {
    const approval = await confirmScriptContent(
      getState(),
      repoId,
      'setup',
      scriptContent,
      hostId,
      undefined,
      undefined,
      review
    )
    // Repo-wide trust approves any content, but the host runs only content it can match.
    return approval.decision === 'run' && approval.approvedContentHash === undefined
      ? { decision: 'run', approvedContentHash: await hashOrcaHookScript(scriptContent) }
      : approval
  })
}

export async function ensureHooksApproved(
  // Read current trust when dequeued so earlier prompts’ decisions apply.
  stateOrGetter: AppState | (() => AppState),
  repoId: string,
  scriptKind: OrcaHookTrustKind,
  hostId?: ExecutionHostId,
  runtimeOwnerEnvironmentId?: string | null,
  isCancelled: () => boolean = NEVER_CANCEL_TRUST_CHECK,
  signal?: AbortSignal
): Promise<HookTrustApproval> {
  return enqueueTrustPrompt(async () => {
    if (isCancelled() || signal?.aborted) {
      return SKIP
    }
    const state = typeof stateOrGetter === 'function' ? stateOrGetter() : stateOrGetter
    if (canUseRepoWideTrust(state.trustedOrcaHooks, state.repos, repoId)) {
      return RUN_ANY
    }

    let scriptContent = ''
    try {
      if (scriptKind === 'issueCommand') {
        // Repo-provided commands need trust; untracked user overrides do not. Pass hostId to disambiguate same-ID repos, as checkRuntimeHooks does.
        // A launch is a user act: it may start the repo's stopped WSL distro.
        const result = await readRuntimeIssueCommand(
          hookRepoOwnerHostId(state, repoId, hostId, runtimeOwnerEnvironmentId),
          repoId,
          { wakeWslDistro: true }
        )
        if (isUserOwnedIssueCommand(result)) {
          return RUN_ANY
        }
        if (result.status === 'error') {
          return SKIP
        }
        if (result.source === 'none') {
          return RUN_ANY
        }
        scriptContent = getIssueCommandTrustContent(result)
      } else {
        const repo = findHookRepo(state, repoId, hostId)
        const localScript = repo?.hookSettings?.scripts?.[scriptKind]?.trim()
        const sourcePolicy = resolveHookCommandSourcePolicy(
          repo?.hookSettings?.commandSourcePolicy,
          {
            hasLocalScript: Boolean(localScript)
          }
        )
        if (sourcePolicy === 'local-only') {
          return RUN_ANY
        }
        const group = state.projectGroups.find(
          (entry) => projectGroupHookTrustKey(entry) === repoId
        )
        const result = group
          ? await checkRuntimeGroupHooks(getRepoExecutionHostId(group), group.id)
          : await checkRuntimeHooks(
              hookRepoOwnerHostId(state, repoId, hostId, runtimeOwnerEnvironmentId),
              repoId
            )
        if (result.status === 'error') {
          return SKIP
        }
        const yamlHooks = (result.hooks as OrcaHooks | null) ?? null
        scriptContent =
          scriptKind === 'setup'
            ? getSetupTrustContent(yamlHooks)
            : scriptKind === 'vmRecipe'
              ? getVmRecipeTrustContent(yamlHooks)
              : (yamlHooks?.scripts?.[scriptKind] ?? '').trim()
      }
    } catch {
      // Fail closed: if we cannot inspect the script, we cannot trust it.
      return SKIP
    }

    return confirmScriptContent(
      state,
      repoId,
      scriptKind,
      scriptContent,
      hostId,
      isCancelled,
      signal
    )
  })
}

/** Approval and its execution hash describe one inspected archive snapshot, including whole-owner trust. */
export function confirmInspectedArchiveHook(
  stateOrGetter: AppState | (() => AppState),
  ownerId: string,
  hostId: ExecutionHostId,
  scriptContent: string
): Promise<HookTrustApproval> {
  return enqueueTrustPrompt(async () => {
    const state = typeof stateOrGetter === 'function' ? stateOrGetter() : stateOrGetter
    const approval = await confirmScriptContent(state, ownerId, 'archive', scriptContent, hostId)
    return approval.decision === 'run'
      ? { decision: 'run', approvedContentHash: await hashOrcaHookScript(scriptContent) }
      : approval
  })
}
