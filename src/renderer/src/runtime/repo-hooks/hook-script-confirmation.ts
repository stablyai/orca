import type { AppState } from '@/store/types'
import type { ExecutionHostId } from '../../../../shared/execution-host/execution-host'
import {
  canUseRepoWideTrust,
  isOrcaHookContentApproved,
  isOrcaHookRepoIdOnSeveralHosts,
  isOrcaHookRepoTrusted,
  type OrcaHookTrustKind
} from '../../../../shared/workspace-setup/hooks/orca-hook-trust-entries'
import { MODAL_DISMISSED_KEY } from '@/store/slices/ui/modal-slot-dismissal'
import { hashOrcaHookScript } from './orca-hook-trust'
import { findHookRepo } from './hook-owner-resolution'

export type HookTrustContext = 'workspace' | 'vm' | 'automation'
export type SkippedSetupReview = 'created-branch' | 'automation'

export function usesVersionedHookTrust(
  state: AppState,
  repoId: string,
  context: HookTrustContext
): boolean {
  return context === 'vm' || isOrcaHookRepoIdOnSeveralHosts(state.repos, repoId)
}

export function isDesktopHookRepoTrusted(
  state: AppState,
  repoId: string,
  context: HookTrustContext
): boolean {
  return context === 'vm'
    ? canUseRepoWideTrust(state.trustedOrcaHooks, state.repos, repoId)
    : isOrcaHookRepoTrusted(state.trustedOrcaHooks, state.repos, repoId)
}

const NEVER_CANCEL_TRUST_CHECK = (): boolean => false

/** A run carries the approved content's hash (empty content included) unless the whole repo is trusted. */
export type HookTrustApproval = { decision: 'run' | 'skip'; approvedContentHash?: string }

export const SKIP: HookTrustApproval = { decision: 'skip' }
export const RUN_ANY: HookTrustApproval = { decision: 'run' }

export async function confirmScriptContent(
  state: AppState,
  repoId: string,
  scriptKind: OrcaHookTrustKind,
  scriptContent: string,
  hostId?: ExecutionHostId,
  isCancelled: () => boolean = NEVER_CANCEL_TRUST_CHECK,
  signal?: AbortSignal,
  skippedSetupReview?: SkippedSetupReview,
  context: HookTrustContext = 'workspace'
): Promise<HookTrustApproval> {
  if (isCancelled() || signal?.aborted) {
    return SKIP
  }
  if (isDesktopHookRepoTrusted(state, repoId, context)) {
    return RUN_ANY
  }

  const versionOnly = usesVersionedHookTrust(state, repoId, context)
  const contentHash = await hashOrcaHookScript(scriptContent)
  if (isCancelled() || signal?.aborted) {
    return SKIP
  }
  const approved: HookTrustApproval = { decision: 'run', approvedContentHash: contentHash }
  const existingHash = state.trustedOrcaHooks[repoId]?.[scriptKind]?.contentHash
  if (
    !scriptContent ||
    (versionOnly &&
      isOrcaHookContentApproved(state.trustedOrcaHooks, repoId, scriptKind, contentHash))
  ) {
    return approved
  }

  const repo = findHookRepo(state, repoId, hostId)
  const repoName = repo?.displayName ?? 'this repository'
  const previouslyApproved = versionOnly && Boolean(existingHash)

  const decision = await new Promise<'run' | 'trust' | 'skip'>((resolve) => {
    let settled = false
    const settle = (decision: 'run' | 'trust' | 'skip'): void => {
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
      versionOnly,
      repoWideTrust: !isOrcaHookRepoIdOnSeveralHosts(state.repos, repoId),
      automation: context === 'automation',
      ...(skippedSetupReview ? { skippedSetupReview } : {}),
      onResolve: settle,
      // Why: eviction must fail closed without stranding the singleton trust queue.
      [MODAL_DISMISSED_KEY]: () => settle('skip')
    })
  })
  return decision === 'trust' && !versionOnly ? RUN_ANY : decision !== 'skip' ? approved : SKIP
}
