import { findHookRepo, hookRepoOwnerHostId } from './hook-owner-resolution'
import { projectGroupHookTrustKey } from '../../../../shared/workspace-setup/hooks/workspace-hook-owner'
import type { AppState } from '@/store/types'
import type { OrcaHooks } from '../../../../shared/workspace-setup/orca-yaml-hook-types'
import { resolveHookCommandSourcePolicy } from '../../../../shared/workspace-setup/hooks/hook-command-source-policy'
import { getSetupTrustContent } from '../../../../shared/workspace-setup/hooks/orca-hook-setup-config'
import { hashOrcaHookScript } from './orca-hook-trust'
import type { OrcaHookTrustKind } from '../../../../shared/workspace-setup/hooks/orca-hook-trust-entries'
import { getVmRecipeTrustContent } from './vm-recipe-trust-content'
import type { SetupHooksCreateSource } from '../../../../shared/worktree/setup-hooks-create-source'
import { getIssueCommandTrustContent, isUserOwnedIssueCommand } from './issue-command-trust-content'
import {
  checkRuntimeHooks,
  checkRuntimeGroupHooks,
  readRuntimeIssueCommand,
  type IssueCommandReadResult
} from '@/runtime/repo-hooks/runtime-hooks-client'
import {
  confirmScriptContent,
  isDesktopHookRepoTrusted,
  SKIP,
  RUN_ANY,
  type HookTrustApproval,
  type HookTrustContext,
  type SkippedSetupReview
} from './hook-script-confirmation'
export type { HookTrustApproval, SkippedSetupReview } from './hook-script-confirmation'
import {
  getRepoExecutionHostId,
  type ExecutionHostId
} from '../../../../shared/execution-host/execution-host'

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

async function confirmIssueCommandReadResult(
  state: AppState,
  repoId: string,
  hostId: ExecutionHostId,
  result: IssueCommandReadResult,
  isCancelled: () => boolean = NEVER_CANCEL_TRUST_CHECK,
  context: HookTrustContext = 'workspace'
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
    isCancelled,
    undefined,
    undefined,
    context
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
  isCancelled: () => boolean = NEVER_CANCEL_TRUST_CHECK,
  context: HookTrustContext = 'workspace'
): Promise<ConfirmedRuntimeIssueCommand> {
  return enqueueTrustPrompt(async () => ({
    result,
    template: getIssueCommandTrustContent(result),
    trustDecision: await confirmIssueCommandReadResult(
      state,
      repoId,
      hostId,
      result,
      isCancelled,
      context
    )
  }))
}

export async function readAndConfirmRuntimeIssueCommand(
  state: AppState,
  repoId: string,
  hostId: ExecutionHostId,
  isCancelled: () => boolean = NEVER_CANCEL_TRUST_CHECK,
  context: HookTrustContext = 'workspace'
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
  return confirmRuntimeIssueCommandRead(state, repoId, hostId, result, isCancelled, context)
}

export async function ensureHooksConfirmed(
  ...args: Parameters<typeof ensureHooksApproved>
): Promise<'run' | 'skip'> {
  return (await ensureHooksApproved(...args)).decision
}

/**
 * Re-prompt with setup content that a create or automation run skipped because it differs from
 * what was approved. Always trust approves the repo; Run once leaves trust unchanged.
 */
export function confirmCreatedWorktreeSetupContent(
  getState: () => AppState,
  repoId: string,
  scriptContent: string,
  hostId?: ExecutionHostId,
  review: SkippedSetupReview = 'created-branch',
  context: HookTrustContext = review === 'automation' ? 'automation' : 'workspace'
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
      review,
      context
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
  signal?: AbortSignal,
  /** Setup for a create: read orca.yaml at the ref it checks out, not the project checkout. */
  createSource?: SetupHooksCreateSource,
  context: HookTrustContext = 'workspace'
): Promise<HookTrustApproval> {
  return enqueueTrustPrompt(async () => {
    if (isCancelled() || signal?.aborted) {
      return SKIP
    }
    const state = typeof stateOrGetter === 'function' ? stateOrGetter() : stateOrGetter
    if (isDesktopHookRepoTrusted(state, repoId, context)) {
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
              repoId,
              scriptKind === 'setup' && createSource ? { createSource } : {}
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
      signal,
      undefined,
      context
    )
  })
}
