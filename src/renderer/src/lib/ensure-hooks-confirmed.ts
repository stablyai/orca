import type { AppState } from '@/store/types'
import type { OrcaHooks } from '../../../shared/types'
import { resolveHookCommandSourcePolicy } from '../../../shared/hook-command-source-policy'
import { hashOrcaHookScript, type OrcaHookScriptKind } from './orca-hook-trust'
import {
  checkRuntimeHooks,
  readRuntimeIssueCommand,
  type IssueCommandReadResult
} from '@/runtime/runtime-hooks-client'
import { getRuntimeEnvironmentIdForRepo } from './repo-runtime-owner'
import {
  getRepoExecutionHostId,
  parseExecutionHostId,
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

function getSetupTrustContent(yamlHooks: OrcaHooks | null): string {
  const defaultTabCommands = (yamlHooks?.defaultTabs ?? [])
    .map((tab, index) => {
      const command = tab.command?.trim()
      if (!command) {
        return null
      }
      const label = tab.title ? ` ${tab.title}` : ''
      return `# defaultTabs[${index + 1}]${label}\n${command}`
    })
    .filter((entry): entry is string => entry !== null)
  return [yamlHooks?.scripts?.setup?.trim(), ...defaultTabCommands].filter(Boolean).join('\n\n')
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

function settingsForHookRepoOwner(
  state: AppState,
  repoId: string,
  hostId?: ExecutionHostId,
  runtimeOwnerEnvironmentId?: string | null
): AppState['settings'] {
  const parsedHost = hostId ? parseExecutionHostId(hostId) : null
  const runtimeEnvironmentId =
    runtimeOwnerEnvironmentId?.trim() ||
    (hostId
      ? parsedHost?.kind === 'runtime'
        ? parsedHost.environmentId
        : null
      : getRuntimeEnvironmentIdForRepo(state, repoId))
  // Why: hook inspection must follow the repo owner. SSH/local repos execute
  // through desktop IPC, while runtime repos may differ from the focused host.
  return state.settings
    ? { ...state.settings, activeRuntimeEnvironmentId: runtimeEnvironmentId }
    : ({ activeRuntimeEnvironmentId: runtimeEnvironmentId } as AppState['settings'])
}

function canUseRepoWideTrust(state: AppState, repoId: string): boolean {
  const hasDuplicateRepoId = state.repos.filter((repo) => repo.id === repoId).length > 1
  return Boolean(state.trustedOrcaHooks[repoId]?.all) && !hasDuplicateRepoId
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
  if (canUseRepoWideTrust(state, repoId) || !scriptContent) {
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
    state.openModal('confirm-orca-yaml-hooks', {
      repoId,
      repoName,
      scriptKind,
      scriptContent,
      contentHash,
      previouslyApproved,
      onResolve: (decision: 'run' | 'skip') => resolve(decision)
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

export function confirmRuntimeIssueCommandRead(
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
    result = await readRuntimeIssueCommand(
      settingsForHookRepoOwner(state, repoId, hostId),
      repoId,
      hostId
    )
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
  state: AppState,
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
    if (canUseRepoWideTrust(state, repoId)) {
      return 'run'
    }

    let scriptContent = ''
    try {
      if (scriptKind === 'issueCommand') {
        // Local overrides are user-owned; only shared orca.yaml commands need repo trust.
        // Why: hostId disambiguates duplicate repo ids on the local IPC path,
        // matching the checkRuntimeHooks call below.
        const result = await readRuntimeIssueCommand(
          settingsForHookRepoOwner(state, repoId, hostId, runtimeOwnerEnvironmentId),
          repoId,
          hostId
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
          settingsForHookRepoOwner(state, repoId, hostId, runtimeOwnerEnvironmentId),
          repoId,
          hostId
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
