import type { AppState } from '@/store/types'
import type { OrcaHooks } from '../../../shared/orca-yaml-hook-types'
import { resolveHookCommandSourcePolicy } from '../../../shared/hook-command-source-policy'
import { hashOrcaHookScript, type OrcaHookScriptKind } from './orca-hook-trust'
import {
  checkRuntimeHooks,
  readRuntimeIssueCommand,
  type IssueCommandReadResult
} from '@/runtime/runtime-hooks-client'
import { parseExecutionHostId, type ExecutionHostId } from '../../../shared/execution-host'
import {
  parseSetupHookTrust,
  setupHookApprovalFromTrust,
  type SetupHookApproval
} from '../../../shared/setup-hook-approval'
import {
  NEVER_CANCEL_TRUST_CHECK,
  canUseRepoWideTrust,
  confirmScriptContent,
  findHookRepo,
  settingsForHookRepoOwner
} from './hook-trust-confirmation'

export type HookScriptKind = OrcaHookScriptKind

export type ConfirmedSetupHook = {
  decision: 'run' | 'skip'
  approval?: SetupHookApproval
  approvalRequired: boolean
}

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
  if (scriptKind === 'setup') {
    return (
      await ensureSetupHookConfirmed(state, repoId, hostId, runtimeOwnerEnvironmentId, isCancelled)
    ).decision
  }
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
          scriptKind === 'vmRecipe'
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

export async function ensureSetupHookConfirmed(
  state: AppState,
  repoId: string,
  hostId?: ExecutionHostId,
  runtimeOwnerEnvironmentId?: string | null,
  isCancelled: () => boolean = NEVER_CANCEL_TRUST_CHECK
): Promise<ConfirmedSetupHook> {
  return enqueueTrustPrompt(async () => {
    if (isCancelled()) {
      return { decision: 'skip', approvalRequired: false }
    }
    const repo = findHookRepo(state, repoId, hostId)
    const remoteApprovalRequired =
      parseExecutionHostId(hostId)?.kind === 'runtime' || Boolean(runtimeOwnerEnvironmentId?.trim())
    if (canUseRepoWideTrust(state, repoId) && !remoteApprovalRequired) {
      return { decision: 'run', approvalRequired: false }
    }
    const localScript = repo?.hookSettings?.scripts?.setup?.trim()
    const sourcePolicy = resolveHookCommandSourcePolicy(repo?.hookSettings?.commandSourcePolicy, {
      hasLocalScript: Boolean(localScript)
    })
    if (sourcePolicy === 'local-only' && !remoteApprovalRequired) {
      return { decision: 'run', approvalRequired: false }
    }

    try {
      const result = await checkRuntimeHooks(
        settingsForHookRepoOwner(state, repoId, hostId, runtimeOwnerEnvironmentId),
        repoId,
        hostId
      )
      if (result.status === 'error') {
        return { decision: 'skip', approvalRequired: false }
      }
      const yamlHooks = (result.hooks as OrcaHooks | null) ?? null
      const setupTrust = parseSetupHookTrust(result.setupTrust)
      const scriptContent = setupTrust?.scriptContent ?? getSetupTrustContent(yamlHooks)
      const approvalRequired = Boolean(scriptContent)
      if (
        setupTrust &&
        (await hashOrcaHookScript(setupTrust.scriptContent)) !== setupTrust.contentHash
      ) {
        return { decision: 'skip', approvalRequired }
      }
      const decision = await confirmScriptContent(
        state,
        repoId,
        'setup',
        scriptContent,
        hostId,
        isCancelled
      )
      return {
        decision,
        approvalRequired,
        ...(decision === 'run' ? { approval: setupHookApprovalFromTrust(setupTrust) } : {})
      }
    } catch {
      return { decision: 'skip', approvalRequired: false }
    }
  })
}
