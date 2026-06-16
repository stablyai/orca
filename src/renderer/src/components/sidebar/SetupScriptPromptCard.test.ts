import { describe, expect, it } from 'vitest'
import { getRenderedSetupScriptPromptState } from './setup-script-prompt-render-state'
import type { SetupScriptPromptInspection } from '@/lib/setup-script-prompt'

function prompt(repoId: string): SetupScriptPromptInspection {
  return {
    status: 'ok',
    repoId,
    hasEffectiveSetup: false,
    hasSharedHooks: false,
    candidate: null
  }
}

describe('getRenderedSetupScriptPromptState', () => {
  it('uses the current inspection when it belongs to the active repo', () => {
    const current = prompt('repo-local')

    expect(
      getRenderedSetupScriptPromptState({
        promptState: current,
        activeRepoId: 'repo-local',
        activeProjectId: 'github:stablyai/orca',
        lastVisiblePrompt: { state: prompt('repo-ssh'), projectId: 'github:stablyai/orca' }
      })
    ).toBe(current)
  })

  it('keeps the previous visible prompt during same-project host inspection refresh', () => {
    const previous = prompt('repo-local')

    expect(
      getRenderedSetupScriptPromptState({
        promptState: null,
        activeRepoId: 'repo-ssh',
        activeProjectId: 'github:stablyai/orca',
        lastVisiblePrompt: { state: previous, projectId: 'github:stablyai/orca' }
      })
    ).toBe(previous)
  })

  it('does not keep a stale prompt when switching to a different project', () => {
    expect(
      getRenderedSetupScriptPromptState({
        promptState: null,
        activeRepoId: 'repo-other',
        activeProjectId: 'github:stablyai/other',
        lastVisiblePrompt: { state: prompt('repo-local'), projectId: 'github:stablyai/orca' }
      })
    ).toBeNull()
  })
})
