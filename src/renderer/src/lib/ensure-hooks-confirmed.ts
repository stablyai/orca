import type { AppState } from '@/store/types'
import type { OrcaHooks } from '../../../shared/types'
import { resolveHookCommandSourcePolicy } from '../../../shared/hook-command-source-policy'
import { hashOrcaHookScript, type OrcaHookScriptKind } from './orca-hook-trust'
import { checkRuntimeHooks, readRuntimeIssueCommand } from '@/runtime/runtime-hooks-client'
import { getRuntimeEnvironmentIdForRepo } from './repo-runtime-owner'

export type HookScriptKind = OrcaHookScriptKind

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

function settingsForHookRepoOwner(state: AppState, repoId: string): AppState['settings'] {
  const runtimeEnvironmentId = getRuntimeEnvironmentIdForRepo(state, repoId)
  // Why: hook inspection must follow the repo owner. SSH/local repos execute
  // through desktop IPC, while runtime repos may differ from the focused host.
  return state.settings
    ? { ...state.settings, activeRuntimeEnvironmentId: runtimeEnvironmentId }
    : ({ activeRuntimeEnvironmentId: runtimeEnvironmentId } as AppState['settings'])
}

export async function ensureHooksConfirmed(
  state: AppState,
  repoId: string,
  scriptKind: HookScriptKind
): Promise<'run' | 'skip'> {
  return enqueueTrustPrompt(async () => {
    if (state.trustedOrcaHooks[repoId]?.all) {
      return 'run'
    }

    let scriptContent = ''
    try {
      if (scriptKind === 'issueCommand') {
        // Local overrides are user-owned; only shared orca.yaml commands need repo trust.
        const result = await readRuntimeIssueCommand(
          settingsForHookRepoOwner(state, repoId),
          repoId
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
        const repo = state.repos.find((r) => r.id === repoId)
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
        const result = await checkRuntimeHooks(settingsForHookRepoOwner(state, repoId), repoId)
        if (result.status === 'error') {
          return 'skip'
        }
        const yamlHooks = (result.hooks as OrcaHooks | null) ?? null
        scriptContent =
          scriptKind === 'setup'
            ? getSetupTrustContent(yamlHooks)
            : (yamlHooks?.scripts?.[scriptKind] ?? '').trim()
      }
    } catch {
      // Fail closed: if we cannot inspect the script, we cannot trust it.
      return 'skip'
    }

    if (!scriptContent) {
      return 'run'
    }

    const contentHash = await hashOrcaHookScript(scriptContent)
    const existingHash = state.trustedOrcaHooks[repoId]?.[scriptKind]?.contentHash
    if (existingHash === contentHash) {
      return 'run'
    }

    const repo = state.repos.find((r) => r.id === repoId)
    const repoName = repo?.displayName ?? 'this repository'
    // A non-empty existingHash that didn't match means the user approved a previous
    // version of this script; the prompt is reappearing because orca.yaml changed.
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
  })
}
