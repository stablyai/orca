import { useEffect } from 'react'
import { inspectSetupScriptPromptState } from '@/runtime/repo-hooks/setup-script-prompt'
import {
  checkRuntimeHooks,
  inspectRuntimeSetupScriptImports
} from '@/runtime/repo-hooks/runtime-hooks-client'
import type { GlobalSettings } from '../../../../shared/global-settings-types'
import { isGitRepoKind } from '../../../../shared/repo-kind'
import type { Repo } from '../../../../shared/repo-types'
import { getRepoHostIdentity } from '../../../../shared/repo-host-identity'
import { getRepoExecutionHostId } from '../../../../shared/execution-host'
import type { SetupScriptPromptState } from './setup-script-prompt-render-state'

/** Inspect the active repo's setup while the prompt can show; settings changes and retries inspect again. */
export function useSetupScriptPromptInspection(input: {
  activeRepo: Repo | null
  isDismissed: boolean
  sidebarOpen: boolean
  settings: GlobalSettings | null
  inspectionRetryKey: number
  setPromptState: (state: SetupScriptPromptState | null) => void
  setDetectedSetupDraft: (draft: string) => void
}): void {
  const {
    activeRepo,
    isDismissed,
    sidebarOpen,
    settings,
    inspectionRetryKey,
    setPromptState,
    setDetectedSetupDraft
  } = input
  useEffect(() => {
    if (!sidebarOpen || !activeRepo || !isGitRepoKind(activeRepo) || isDismissed) {
      setPromptState(null)
      setDetectedSetupDraft('')
      return
    }

    const repo = activeRepo
    let cancelled = false
    setPromptState(null)

    async function inspectRepoSetup(): Promise<void> {
      const hostId = getRepoExecutionHostId(repo)
      const inspection = await inspectSetupScriptPromptState({
        repo,
        checkHooks: () => checkRuntimeHooks(hostId, repo.id, { background: true }),
        inspectImports: () => inspectRuntimeSetupScriptImports(hostId, repo.id)
      })
      if (!cancelled) {
        const nextState = {
          ...inspection,
          repoHostIdentity: getRepoHostIdentity(repo)
        }
        setPromptState(nextState)
        setDetectedSetupDraft(
          nextState.status === 'ok' && nextState.candidate?.provider === 'package-manager'
            ? nextState.candidate.setup
            : ''
        )
      }
    }

    void inspectRepoSetup()

    return () => {
      cancelled = true
    }
  }, [
    activeRepo,
    inspectionRetryKey,
    isDismissed,
    settings,
    sidebarOpen,
    setDetectedSetupDraft,
    setPromptState
  ])
}
