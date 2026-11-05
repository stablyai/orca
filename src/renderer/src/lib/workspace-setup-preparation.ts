import type { HookCheckResult } from '@/runtime/runtime-hooks-client'
import { checkRuntimeHooks } from '@/runtime/runtime-hooks-client'
import type { ExecutionHostId } from '../../../shared/execution-host'
import type { OrcaHooks, RepoHookSettings } from '../../../shared/orca-yaml-hook-types'
import type { SetupDecision } from '../../../shared/worktree/create-types'
import { resolveHookCommandSourcePolicy } from '../../../shared/hook-command-source-policy'
import {
  getSetupConfig,
  getDefaultSetupDecision,
  type SetupConfig
} from '../../../shared/orca-hook-setup-config'
import { settleComposerSubmit } from './composer-submit-cancellation'

type SetupRepo = { hookSettings?: RepoHookSettings }
type SetupReadOutcome =
  | { status: 'completed'; value: HookCheckResult }
  | { status: 'failed' }
  | { status: 'cancelled' }

export type WorkspaceSetupInspection =
  | { kind: 'decided'; decision: SetupDecision }
  | { kind: 'needs-modal'; setupConfig: SetupConfig }
  | { kind: 'unavailable' }

export async function readWorkspaceSetupInspection(
  loadHooks: () => Promise<HookCheckResult>,
  isCancelled: () => boolean
): Promise<SetupReadOutcome> {
  try {
    return await settleComposerSubmit(loadHooks(), isCancelled)
  } catch {
    return isCancelled() ? { status: 'cancelled' } : { status: 'failed' }
  }
}

/** Preserve the composer's background refusal and submit-time hook-free error fallback. */
export function getComposerSetupInspectionCommit(
  outcome: SetupReadOutcome,
  phase: 'background' | 'submit'
): { hooks: OrcaHooks | null } | null {
  if (outcome.status === 'cancelled') {
    return null
  }
  if (outcome.status === 'failed') {
    return { hooks: null }
  }
  if (phase === 'background' && outcome.value.unavailable) {
    return null
  }
  return { hooks: outcome.value.hooks }
}

export function deriveWorkspaceSetupState(
  repo: SetupRepo | undefined,
  setupConfig: SetupConfig | null,
  decision: 'run' | 'skip' | null,
  isGit = true,
  isSetupCheckPending = false
) {
  const setupPolicy = repo?.hookSettings?.setupRunPolicy ?? 'run-by-default'
  return {
    setupConfig,
    setupPolicy,
    requiresExplicitSetupChoice: Boolean(setupConfig) && setupPolicy === 'ask',
    resolvedSetupDecision: decision ?? getDefaultSetupDecision(Boolean(setupConfig), setupPolicy),
    shouldWaitForSetupCheck: Boolean(repo) && isGit && isSetupCheckPending
  }
}

export async function inspectRequiredWorkspaceSetup(
  repoId: string,
  repo: SetupRepo,
  ownerHostId: ExecutionHostId
): Promise<WorkspaceSetupInspection> {
  let yamlHooks: OrcaHooks | null = null
  if (
    resolveHookCommandSourcePolicy(repo.hookSettings?.commandSourcePolicy, {
      hasLocalScript: Boolean(repo.hookSettings?.scripts?.setup?.trim())
    }) !== 'local-only'
  ) {
    const outcome = await readWorkspaceSetupInspection(
      () => checkRuntimeHooks(ownerHostId, repoId),
      () => false
    )
    if (outcome.status !== 'completed') {
      return { kind: 'unavailable' }
    }
    const result = outcome.value
    if (result.status === 'error' || result.unavailable || (result.hasHooks && !result.hooks)) {
      return { kind: 'unavailable' }
    }
    yamlHooks = result.hooks ?? null
  }
  const { setupConfig, resolvedSetupDecision } = deriveWorkspaceSetupState(
    repo,
    getSetupConfig(repo, yamlHooks),
    null
  )
  if (!setupConfig) {
    return { kind: 'decided', decision: 'inherit' }
  }
  return resolvedSetupDecision
    ? { kind: 'decided', decision: resolvedSetupDecision }
    : { kind: 'needs-modal', setupConfig }
}
