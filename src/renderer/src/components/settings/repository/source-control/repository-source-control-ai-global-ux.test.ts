// @vitest-environment happy-dom
import { act, renderHook } from '@testing-library/react'
import { describe, expect, it, vi } from 'vitest'

import { normalizeSourceControlAiSettings } from '../../../../../../shared/source-control/ai/settings/source-control-ai-settings'
import type { RepoSourceControlAiOverrides } from '../../../../../../shared/source-control/ai/settings/source-control-ai-settings-types'

import { useRepositorySourceControlAiGlobalUx } from './repository-source-control-ai-global-ux'

import type { SourceControlAiRepoUpdate } from '../../../../../../shared/source-control/ai/settings/source-control-ai-recipe-save'

import { liftActionPermissionArgs } from '../../../../../../shared/source-control/ai/recipes/source-control-action-permission-lift'

const source = normalizeSourceControlAiSettings(undefined, undefined)

function setup(
  persistedRepoAi: RepoSourceControlAiOverrides,
  updateRepo: (repoId: string, updates: SourceControlAiRepoUpdate) => void | Promise<boolean>,
  repoId = 'repo-1'
) {
  return renderHook(
    (props: { repoId: string; persistedRepoAi: RepoSourceControlAiOverrides }) =>
      useRepositorySourceControlAiGlobalUx({
        repoId: props.repoId,
        persistedRepoAi: props.persistedRepoAi,
        settings: null,
        source,
        updateRepo
      }),
    { initialProps: { repoId, persistedRepoAi } }
  )
}

const withRecipe = (commandInputTemplate: string): RepoSourceControlAiOverrides => ({
  actionOverrides: {
    fixCommitFailure: { agentId: null, commandInputTemplate, agentArgs: '' }
  }
})

describe('useRepositorySourceControlAiGlobalUx', () => {
  it('preserves keystrokes typed while an action save is in flight', async () => {
    let resolveUpdate: (ok: boolean) => void = () => {}
    const updateRepo = vi.fn().mockReturnValue(
      new Promise<boolean>((resolve) => {
        resolveUpdate = resolve
      })
    )
    const { result } = setup(
      {
        actionOverrides: {
          fixCommitFailure: liftActionPermissionArgs({
            agentId: 'claude' as const,
            agentArgs: '--model opus --verbose',
            commandInputTemplate: 'orig'
          })
        }
      },
      updateRepo
    )
    act(() => {
      result.current.updateActionTemplate('fixCommitFailure', 'first')
    })
    let savePromise: Promise<void> = Promise.resolve()
    await act(async () => {
      savePromise = result.current.saveActionRecipeText('fixCommitFailure')
      // Flush queued work into updateRepo before leaving the save pending.
      await Promise.resolve()
      await Promise.resolve()
    })
    expect(updateRepo).toHaveBeenCalledTimes(1)
    act(() => {
      result.current.updateActionTemplate('fixCommitFailure', 'first-and-more')
      result.current.updateActionAgentArgs('fixCommitFailure', '--effort low --verbose', true)
    })
    await act(async () => {
      resolveUpdate(true)
      await savePromise
    })
    expect(
      result.current.displayRepoAi.actionOverrides?.fixCommitFailure?.commandInputTemplate
    ).toBe('first-and-more')
    expect(result.current.actionDirtyById.fixCommitFailure).toBe(true)
    expect(
      result.current.displayRepoAi.actionOverrides?.fixCommitFailure?.argumentChoices?.nodes.map(
        (node) => node.text
      )
    ).toEqual(['--model opus', '--effort low'])
  })

  it('resets drafts and saving state when the selected repo changes', async () => {
    let resolveUpdate: (ok: boolean) => void = () => {}
    const updateRepo = vi.fn().mockReturnValue(
      new Promise<boolean>((resolve) => {
        resolveUpdate = resolve
      })
    )
    const { result, rerender } = setup(withRecipe('orig'), updateRepo)
    act(() => {
      result.current.updateActionTemplate('fixCommitFailure', 'editing-a')
      result.current.updateCustomCommand('cmd-a')
    })
    let savePromise: Promise<void> = Promise.resolve()
    await act(async () => {
      savePromise = result.current.saveActionRecipeText('fixCommitFailure')
      await Promise.resolve()
      await Promise.resolve()
    })
    expect(result.current.savingActionIds.fixCommitFailure).toBe(true)

    await act(async () => {
      rerender({ repoId: 'repo-2', persistedRepoAi: withRecipe('repo-2-template') })
    })
    expect(
      result.current.displayRepoAi.actionOverrides?.fixCommitFailure?.commandInputTemplate
    ).toBe('repo-2-template')
    expect(result.current.displayRepoAi.customAgentCommand).toBeUndefined()
    expect(result.current.savingActionIds.fixCommitFailure).toBeFalsy()
    expect(result.current.actionDirtyById.fixCommitFailure).toBe(false)

    await act(async () => {
      resolveUpdate(true)
      await savePromise
    })
    // Old-repo save completion must not reapply its draft to the new repo.
    expect(
      result.current.displayRepoAi.actionOverrides?.fixCommitFailure?.commandInputTemplate
    ).toBe('repo-2-template')
  })
})
