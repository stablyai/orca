import type { AppState } from '@/store/types'
import type { OrcaHooks } from '../../../shared/types'
import { hashOrcaHookScript, type OrcaHookScriptKind } from './orca-hook-trust'
import { checkRuntimeHooks, readRuntimeIssueCommand } from '@/runtime/runtime-hooks-client'

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
        const result = await readRuntimeIssueCommand(state.settings, repoId)
        if (result.source !== 'shared') {
          return 'run'
        }
        scriptContent = (result.sharedContent ?? '').trim()
      } else {
        const result = await checkRuntimeHooks(state.settings, repoId)
        const yamlHooks = (result.hooks as OrcaHooks | null) ?? null
        scriptContent = (yamlHooks?.scripts?.[scriptKind] ?? '').trim()
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
