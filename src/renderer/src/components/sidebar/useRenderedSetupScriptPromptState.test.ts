// @vitest-environment happy-dom

import { renderHook } from '@testing-library/react'
import { describe, expect, it } from 'vitest'
import { getRepoHostIdentityForParts } from '@/store/slices/repo-host-identity'
import type { SetupScriptPromptState } from './setup-script-prompt-render-state'
import { useRenderedSetupScriptPromptState } from './useRenderedSetupScriptPromptState'

function prompt(repoId: string, hostId: string): SetupScriptPromptState {
  return {
    status: 'ok',
    repoId,
    repoHostIdentity: getRepoHostIdentityForParts(repoId, hostId),
    hasEffectiveSetup: false,
    hasSharedHooks: false,
    candidate: null
  }
}

describe('useRenderedSetupScriptPromptState', () => {
  it('preserves a committed same-host prompt without leaking it to another host', () => {
    const local = prompt('repo-1', 'local')
    const { result, rerender } = renderHook(
      ({ hostIdentity, promptState }) =>
        useRenderedSetupScriptPromptState({
          promptState,
          activeRepoId: 'repo-1',
          activeRepoHostIdentity: hostIdentity,
          promptTargetHidden: false
        }),
      {
        initialProps: {
          hostIdentity: local.repoHostIdentity,
          promptState: local as SetupScriptPromptState | null
        }
      }
    )

    rerender({ hostIdentity: local.repoHostIdentity, promptState: null })
    expect(result.current).toBe(local)

    rerender({
      hostIdentity: getRepoHostIdentityForParts('repo-1', 'ssh:windows'),
      promptState: null
    })
    expect(result.current).toBeNull()
  })
})
