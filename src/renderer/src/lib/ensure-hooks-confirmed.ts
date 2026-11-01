import type { AppState } from '@/store/types'
import type { OrcaHooks } from '../../../shared/orca-yaml-hook-types'
import { resolveHookCommandSourcePolicy } from '../../../shared/hook-command-source-policy'
import { getSetupTrustContent } from '../../../shared/orca-hook-setup-config'
import { canUseRepoWideTrust } from '../../../shared/orca-hook-trust-entries'
import { hashOrcaHookScript, type OrcaHookScriptKind } from './orca-hook-trust'
import {
  checkRuntimeHooks,
  readRuntimeIssueCommand,
  type IssueCommandReadResult
} from '@/runtime/runtime-hooks-client'
import { MODAL_DISMISSED_KEY } from '@/store/slices/modal-slot-dismissal'
import {
  getRepoExecutionHostId,
  toRuntimeExecutionHostId,
  type ExecutionHostId
} from '../../../shared/execution-host'

export type HookScriptKind = OrcaHookScriptKind

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

function getVmRecipeTrustContent(yamlHooks: OrcaHooks | null): string {
  return (yamlHooks?.environmentRecipes ?? [])
    .map((recipe) =>
      [
        `# environmentRecipes.${recipe.id}`,
        `name: ${recipe.name}`,
        recipe.description ? `description: ${recipe.description}` : null,
        `create: ${recipe.create}`,
        recipe.suspend ? `suspend: ${recipe.suspend}` : null,
        recipe.resume ? `resume: ${recipe.resume}` : null,
        recipe.destroyDisabled
          ? 'destroy: none'
          : recipe.destroy
            ? `destroy: ${recipe.destroy}`
            : null
      ]
        .filter((entry): entry is string => entry !== null)
        .join('\n')
    )
    .join('\n\n')
}

function findHookRepo(state: AppState, repoId: string, hostId?: ExecutionHostId) {
  return hostId
    ? state.repos.find((repo) => repo.id === repoId && getRepoExecutionHostId(repo) === hostId)
    : state.repos.find((repo) => repo.id === repoId)
}

/** Inspect on the captured runtime owner, then explicit host, then repo owner; never substitute focused host, including server-owned SSH repos. */
function hookRepoOwnerHostId(
  state: AppState,
  repoId: string,
  hostId?: ExecutionHostId,
  runtimeOwnerEnvironmentId?: string | null
): ExecutionHostId {
  const ownerEnvironmentId = runtimeOwnerEnvironmentId?.trim()
  if (ownerEnvironmentId) {
    return toRuntimeExecutionHostId(ownerEnvironmentId)
  }
  const rows = hostId ? [] : state.repos.filter((entry) => entry.id === repoId)
  // Why: with the id on two hosts, trusting one row's script could run the other's unseen.
  if (rows.length > 1) {
    throw new Error('The project exists on more than one host.')
  }
  const repo = rows[0] ?? null
  const ownerHostId = hostId ?? (repo ? getRepoExecutionHostId(repo) : null)
  if (!ownerHostId) {
    throw new Error('The project host is unknown.')
  }
  return ownerHostId
}

async function confirmScriptContent(
  state: AppState,
  repoId: string,
  scriptKind: HookScriptKind,
  scriptContent: string,
  hostId?: ExecutionHostId,
  isCancelled: () => boolean = NEVER_CANCEL_TRUST_CHECK
): Promise<'run' | 'skip'> {
  if (isCancelled()) {
    return 'skip'
  }
  if (canUseRepoWideTrust(state.trustedOrcaHooks, state.repos, repoId) || !scriptContent) {
    return 'run'
  }

  const contentHash = await hashOrcaHookScript(scriptContent)
  if (isCancelled()) {
    return 'skip'
  }
  const existingHash = state.trustedOrcaHooks[repoId]?.[scriptKind]?.contentHash
  if (existingHash === contentHash) {
    return 'run'
  }

  const repo = findHookRepo(state, repoId, hostId)
  const repoName = repo?.displayName ?? 'this repository'
  const previouslyApproved = Boolean(existingHash)

  return new Promise<'run' | 'skip'>((resolve) => {
    let settled = false
    const settle = (decision: 'run' | 'skip'): void => {
      if (settled) {
        return
      }
      settled = true
      resolve(decision)
    }
    state.openModal('confirm-orca-yaml-hooks', {
      repoId,
      repoName,
      scriptKind,
      scriptContent,
      contentHash,
      previouslyApproved,
      onResolve: settle,
      // Why: eviction must fail closed without stranding the singleton trust queue.
      [MODAL_DISMISSED_KEY]: () => settle('skip')
    })
  })
}

function getIssueCommandTrustContent(result: IssueCommandReadResult): string {
  if (result.source === 'local') {
    return (result.localContent ?? '').trim()
  }
  if (result.source === 'shared') {
    return (result.sharedContent ?? '').trim()
  }
  return ''
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
  if (result.source === 'local') {
    return 'run'
  }
  if (result.status === 'error') {
    return 'skip'
  }
  return confirmScriptContent(
    state,
    repoId,
    'issueCommand',
    getIssueCommandTrustContent(result),
    hostId,
    isCancelled
  )
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
  // Read current trust when dequeued so earlier prompts’ decisions apply.
  stateOrGetter: AppState | (() => AppState),
  repoId: string,
  scriptKind: HookScriptKind,
  hostId?: ExecutionHostId,
  runtimeOwnerEnvironmentId?: string | null,
  isCancelled: () => boolean = NEVER_CANCEL_TRUST_CHECK
): Promise<'run' | 'skip'> {
  return enqueueTrustPrompt(async () => {
    if (isCancelled()) {
      return 'skip'
    }
    const state = typeof stateOrGetter === 'function' ? stateOrGetter() : stateOrGetter
    if (canUseRepoWideTrust(state.trustedOrcaHooks, state.repos, repoId)) {
      return 'run'
    }

    let scriptContent = ''
    try {
      if (scriptKind === 'issueCommand') {
        // Only shared orca.yaml needs repo trust; user-owned overrides do not. Pass hostId to disambiguate same-ID repos, as checkRuntimeHooks does.
        // A launch is a user act: it may start the repo's stopped WSL distro.
        const result = await readRuntimeIssueCommand(
          hookRepoOwnerHostId(state, repoId, hostId, runtimeOwnerEnvironmentId),
          repoId,
          { wakeWslDistro: true }
        )
        if (result.source === 'local') {
          return 'run'
        }
        if (result.status === 'error') {
          return 'skip'
        }
        if (result.source !== 'shared') {
          return 'run'
        }
        scriptContent = (result.sharedContent ?? '').trim()
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
          return 'run'
        }
        const result = await checkRuntimeHooks(
          hookRepoOwnerHostId(state, repoId, hostId, runtimeOwnerEnvironmentId),
          repoId
        )
        if (result.status === 'error') {
          return 'skip'
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
      return 'skip'
    }

    return confirmScriptContent(state, repoId, scriptKind, scriptContent, hostId, isCancelled)
  })
}
