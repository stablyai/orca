import type { ComposerModel } from './composer-model'

export type ComposerProviderRuntimeSyncInput = Pick<
  ComposerModel,
  | 'promptCaretFrameRef'
  | 'repoId'
  | 'selectedRepo'
  | 'selectedRepoExecutionHostId'
  | 'selectedRepoHookContextKey'
  | 'selectedRepoIsGit'
  | 'selectedRepoPath'
  | 'selectedRepoSettings'
  | 'selectedRepoSettingsRef'
  | 'setCheckedHooksContextKey'
  | 'setSelectedRepoSlug'
  | 'setSetupAgentStartupPolicy'
  | 'setYamlHooks'
  | 'setupAgentStartupPolicyDraftRef'
  | 'setupAgentStartupPolicyRef'
  | 'setupAgentStartupPolicySaveRef'
  | 'updateRepo'
>

import { useEffect, useCallback, useRef } from 'react'
import type { SetupAgentStartupPolicy, OrcaHooks } from '../../../../shared/orca-yaml-hook-types'
import { useAppStore } from '@/store'
import { isGitRepoKind } from '../../../../shared/repo-kind'
import { toast } from 'sonner'
import { translate } from '@/i18n/i18n'
import { type HookCheckResult, checkRuntimeHooks } from '@/runtime/runtime-hooks-client'
import { getActiveRuntimeTarget, callRuntimeRpc } from '@/runtime/runtime-rpc-client'
import type { GitHubRepositoryIdentity } from '../../../../shared/github/pull-request-types'
import {
  getRepoSetupAgentStartupPolicy,
  buildSetupAgentStartupHookSettings
} from './setup-policy-decisions'

export function useComposerProviderRuntimeSync(input: ComposerProviderRuntimeSyncInput) {
  const {
    promptCaretFrameRef,
    repoId,
    selectedRepo,
    selectedRepoExecutionHostId,
    selectedRepoHookContextKey,
    selectedRepoIsGit,
    selectedRepoPath,
    selectedRepoSettings,
    selectedRepoSettingsRef,
    setCheckedHooksContextKey,
    setSelectedRepoSlug,
    setSetupAgentStartupPolicy,
    setYamlHooks,
    setupAgentStartupPolicyDraftRef,
    setupAgentStartupPolicyRef,
    setupAgentStartupPolicySaveRef,
    updateRepo
  } = input

  // Why: depend on the persisted policy *value*, not the selectedRepo object. Background repo
  // refetches (git polling) hand back a new repo reference with the same hookSettings; keying on
  // the object would re-run this and briefly flip the toggle back to the stale value — the glitch.
  const persistedSetupAgentStartupPolicy = getRepoSetupAgentStartupPolicy(selectedRepo)

  useEffect(() => {
    const draft = setupAgentStartupPolicyDraftRef.current
    if (draft?.repoId === repoId && draft.policy !== persistedSetupAgentStartupPolicy) {
      return
    }
    setupAgentStartupPolicyRef.current = persistedSetupAgentStartupPolicy
    setSetupAgentStartupPolicy(persistedSetupAgentStartupPolicy)
  }, [
    repoId,
    persistedSetupAgentStartupPolicy,
    setSetupAgentStartupPolicy,
    setupAgentStartupPolicyDraftRef,
    setupAgentStartupPolicyRef
  ])

  const persistSetupAgentStartupPolicy = useCallback(
    async (
      policy: SetupAgentStartupPolicy = setupAgentStartupPolicyRef.current
    ): Promise<boolean> => {
      while (true) {
        const currentRepo = useAppStore.getState().repos.find((repo) => repo.id === repoId)
        if (!currentRepo || !isGitRepoKind(currentRepo)) {
          return true
        }
        const pendingSave = setupAgentStartupPolicySaveRef.current
        if (pendingSave?.repoId === currentRepo.id) {
          if (pendingSave.policy === policy) {
            const saved = await pendingSave.promise
            if (
              saved &&
              setupAgentStartupPolicyDraftRef.current?.repoId === currentRepo.id &&
              setupAgentStartupPolicyDraftRef.current.policy === policy
            ) {
              setupAgentStartupPolicyDraftRef.current = null
            }
            return saved
          }
          await pendingSave.promise
          continue
        }
        if (getRepoSetupAgentStartupPolicy(currentRepo) === policy) {
          if (
            setupAgentStartupPolicyDraftRef.current?.repoId === currentRepo.id &&
            setupAgentStartupPolicyDraftRef.current.policy === policy
          ) {
            setupAgentStartupPolicyDraftRef.current = null
          }
          return true
        }
        const promise = updateRepo(currentRepo.id, {
          hookSettings: buildSetupAgentStartupHookSettings(currentRepo.hookSettings, policy)
        }).finally(() => {
          if (setupAgentStartupPolicySaveRef.current?.promise === promise) {
            setupAgentStartupPolicySaveRef.current = null
          }
        })
        setupAgentStartupPolicySaveRef.current = { repoId: currentRepo.id, policy, promise }
        const saved = await promise
        if (
          saved &&
          setupAgentStartupPolicyDraftRef.current?.repoId === currentRepo.id &&
          setupAgentStartupPolicyDraftRef.current.policy === policy
        ) {
          setupAgentStartupPolicyDraftRef.current = null
        }
        return saved
      }
    },
    [
      repoId,
      updateRepo,
      setupAgentStartupPolicyDraftRef,
      setupAgentStartupPolicyRef,
      setupAgentStartupPolicySaveRef
    ]
  )

  const handleSetupAgentStartupPolicyChange = useCallback(
    (policy: SetupAgentStartupPolicy) => {
      setupAgentStartupPolicyRef.current = policy
      if (repoId) {
        setupAgentStartupPolicyDraftRef.current = { repoId, policy }
      }
      setSetupAgentStartupPolicy(policy)
      void persistSetupAgentStartupPolicy(policy).then((saved) => {
        if (!saved) {
          toast.error(
            translate(
              'auto.hooks.useComposerState.setupAgentStartupPolicySaveFailed',
              'Failed to save setup startup behavior.'
            )
          )
        }
      })
    },
    [
      persistSetupAgentStartupPolicy,
      repoId,
      setSetupAgentStartupPolicy,
      setupAgentStartupPolicyDraftRef,
      setupAgentStartupPolicyRef
    ]
  )

  const cancelPromptCaretFrame = useCallback((): void => {
    if (promptCaretFrameRef.current === null) {
      return
    }
    cancelAnimationFrame(promptCaretFrameRef.current)
    promptCaretFrameRef.current = null
  }, [promptCaretFrameRef])

  const handleComposerNodeChange = useCallback(
    (node: HTMLDivElement | null): void => {
      // Why: cancel the queued caret restoration once the composer root (its target's ancestor) leaves the DOM.
      if (!node) {
        cancelPromptCaretFrame()
      }
    },
    [cancelPromptCaretFrame]
  )

  const hookCheckRef = useRef<{
    key: string
    promise: Promise<HookCheckResult>
  } | null>(null)

  const loadHookCheckForRepo = useCallback(
    (targetRepoId: string): Promise<HookCheckResult> => {
      const key = JSON.stringify([selectedRepoExecutionHostId ?? 'local', targetRepoId])
      const existing = hookCheckRef.current
      if (existing?.key === key) {
        return existing.promise
      }
      // Why: drop the cache entry on failure so a transient IPC error doesn't pin every later
      // check for this repo/host to the same rejection.
      const promise: Promise<HookCheckResult> = checkRuntimeHooks(
        selectedRepoSettingsRef.current,
        targetRepoId,
        selectedRepoExecutionHostId ?? undefined
      ).catch((error: unknown) => {
        if (hookCheckRef.current?.promise === promise) {
          hookCheckRef.current = null
        }
        throw error
      })
      hookCheckRef.current = { key, promise }
      return promise
    },
    [selectedRepoExecutionHostId, selectedRepoSettingsRef]
  )

  const commitHookCheckIfCurrent = useCallback(
    (targetContextKey: string, hooks: OrcaHooks | null): boolean => {
      if (selectedRepoHookContextKey !== targetContextKey) {
        return false
      }
      setYamlHooks(hooks)
      setCheckedHooksContextKey(targetContextKey)
      return true
    },
    [selectedRepoHookContextKey, setCheckedHooksContextKey, setYamlHooks]
  )

  useEffect(() => {
    if (!selectedRepo || !selectedRepoPath || !selectedRepoIsGit) {
      setSelectedRepoSlug(null)
      return
    }
    let cancelled = false
    const target = getActiveRuntimeTarget(selectedRepoSettings)
    const slugRequest =
      target.kind === 'environment'
        ? callRuntimeRpc<GitHubRepositoryIdentity | null>(
            target,
            'github.repoSlug',
            { repo: repoId },
            { timeoutMs: 30_000 }
          )
        : (window.api.gh.repoSlug({ repoPath: selectedRepoPath, repoId }) as Promise<{
            owner: string
            repo: string
          } | null>)
    void slugRequest
      .then((result) => {
        if (cancelled) {
          return
        }
        setSelectedRepoSlug(result)
      })
      .catch(() => {
        if (!cancelled) {
          setSelectedRepoSlug(null)
        }
      })
    return () => {
      cancelled = true
    }
  }, [
    repoId,
    selectedRepo,
    selectedRepoIsGit,
    selectedRepoPath,
    selectedRepoSettings,
    setSelectedRepoSlug
  ])

  return {
    persistedSetupAgentStartupPolicy,
    persistSetupAgentStartupPolicy,
    handleSetupAgentStartupPolicyChange,
    cancelPromptCaretFrame,
    handleComposerNodeChange,
    hookCheckRef,
    loadHookCheckForRepo,
    commitHookCheckIfCurrent
  }
}
