import { useEffect, useRef } from 'react'
import {
  getRenderedSetupScriptPromptState,
  type LastVisibleSetupScriptPrompt,
  type SetupScriptPromptState
} from './setup-script-prompt-render-state'

export function useRenderedSetupScriptPromptState(input: {
  promptState: SetupScriptPromptState | null
  activeRepoId: string | null
  activeRepoHostIdentity: string | null
  promptTargetHidden: boolean
}): SetupScriptPromptState | null {
  const { activeRepoHostIdentity, activeRepoId, promptState, promptTargetHidden } = input
  const lastVisiblePromptRef = useRef<LastVisibleSetupScriptPrompt | null>(null)
  const renderedPromptState =
    !promptTargetHidden && activeRepoId && activeRepoHostIdentity
      ? getRenderedSetupScriptPromptState({
          promptState,
          activeRepoId,
          activeRepoHostIdentity,
          lastVisiblePrompt: lastVisiblePromptRef.current
        })
      : null

  useEffect(() => {
    if (
      renderedPromptState?.status === 'ok' &&
      !renderedPromptState.hasEffectiveSetup &&
      renderedPromptState.repoHostIdentity === activeRepoHostIdentity
    ) {
      lastVisiblePromptRef.current = { state: renderedPromptState }
      return
    }
    if (
      promptTargetHidden ||
      renderedPromptState?.status === 'forbidden' ||
      (renderedPromptState?.status === 'ok' && renderedPromptState.hasEffectiveSetup)
    ) {
      lastVisiblePromptRef.current = null
    }
  }, [activeRepoHostIdentity, promptTargetHidden, renderedPromptState])

  return renderedPromptState
}
