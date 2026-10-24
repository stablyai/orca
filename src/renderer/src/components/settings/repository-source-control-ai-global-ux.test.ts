// @vitest-environment happy-dom
import { act, renderHook } from '@testing-library/react'
import { describe, expect, it, vi } from 'vitest'
import { normalizeSourceControlAiSettings } from '../../../../shared/source-control-ai'
import type { RepoSourceControlAiOverrides } from '../../../../shared/source-control-ai-types'
import type { SourceControlAiRepoUpdate } from '../../../../shared/source-control-ai-recipe-save'
import { useRepositorySourceControlAiGlobalUx } from './repository-source-control-ai-global-ux'
import { withRepoAiActionLaunchPreferences } from './repository-source-control-ai-action-agent-draft'
import {
  readActionRecipeTextDraft,
  withRepoAiActionRecipeText
} from './repository-source-control-ai-draft'
import { toSourceControlAiRepoUpdate } from '../../../../shared/source-control-ai-recipe-save'
import type { SourceControlActionId } from '../../../../shared/source-control-ai-actions'
import { getDefaultSettings } from '../../../../shared/constants'
import { resolveSourceControlActionRecipe } from '../../../../shared/source-control-ai-operation-policy'

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
  it('keeps an optimistic immediate field when the persist succeeds', async () => {
    const updateRepo = vi.fn().mockResolvedValue(true)
    const { result } = setup({}, updateRepo)
    await act(async () => {
      result.current.updateEnablement(true)
    })
    expect(result.current.displayRepoAi.enabled).toBe(true)
    expect(updateRepo).toHaveBeenCalledTimes(1)
    expect(result.current.saveError).toBeNull()
  })

  it('drafts the custom command locally and only persists on commit', async () => {
    const updateRepo = vi.fn().mockResolvedValue(true)
    const { result } = setup({}, updateRepo)
    act(() => {
      result.current.updateCustomCommand('ollama run llama3.1 {prompt}')
    })
    // The typed value is shown immediately but NOT written to the backend per keystroke.
    expect(result.current.displayRepoAi.customAgentCommand).toBe('ollama run llama3.1 {prompt}')
    expect(updateRepo).not.toHaveBeenCalled()
    await act(async () => {
      result.current.commitCustomCommand('ollama run llama3.1 {prompt}')
    })
    expect(updateRepo).toHaveBeenCalledTimes(1)
    expect(result.current.displayRepoAi.customAgentCommand).toBe('ollama run llama3.1 {prompt}')
  })

  it('does not call updateRepo when committing an unchanged custom command', async () => {
    const updateRepo = vi.fn().mockResolvedValue(true)
    const { result } = setup({ customAgentCommand: 'same cmd' }, updateRepo)
    await act(async () => {
      result.current.commitCustomCommand('same cmd')
    })
    expect(updateRepo).not.toHaveBeenCalled()
    expect(result.current.saveError).toBeNull()
  })

  it('clears dirty immediately after a successful action save without a prop echo', async () => {
    const updateRepo = vi.fn().mockResolvedValue(true)
    const { result } = setup(withRecipe('orig'), updateRepo)
    act(() => {
      result.current.updateActionTemplate('fixCommitFailure', 'edited')
    })
    expect(result.current.actionDirtyById.fixCommitFailure).toBe(true)
    await act(async () => {
      await result.current.saveActionRecipeText('fixCommitFailure')
    })
    // Baseline advances from setPersisted even before parent re-renders with new props.
    expect(result.current.actionDirtyById.fixCommitFailure).toBe(false)
    expect(
      result.current.displayRepoAi.actionOverrides?.fixCommitFailure?.commandInputTemplate
    ).toBe('edited')
  })

  it('reverts a typed action draft to the persisted template when discarded', async () => {
    const updateRepo = vi.fn().mockResolvedValue(true)
    const { result } = setup(withRecipe('orig'), updateRepo)
    act(() => {
      result.current.updateActionTemplate('fixCommitFailure', 'edited')
    })
    expect(result.current.actionDirtyById.fixCommitFailure).toBe(true)
    act(() => {
      result.current.discardActionRecipeText('fixCommitFailure')
    })
    // Discard drops the draft: dirty clears and the template reverts to the persisted value.
    expect(result.current.actionDirtyById.fixCommitFailure).toBe(false)
    expect(
      result.current.displayRepoAi.actionOverrides?.fixCommitFailure?.commandInputTemplate
    ).toBe('orig')
    expect(updateRepo).not.toHaveBeenCalled()
  })

  it('keeps the custom command draft shown when the commit fails', async () => {
    const updateRepo = vi.fn().mockResolvedValue(false)
    const { result } = setup({}, updateRepo)
    act(() => {
      result.current.updateCustomCommand('bad cmd')
    })
    await act(async () => {
      result.current.commitCustomCommand('bad cmd')
    })
    expect(result.current.displayRepoAi.customAgentCommand).toBe('bad cmd')
    expect(result.current.saveError).toBe('Failed to save Source Control AI settings.')
  })

  it('rolls an optimistic immediate field back to persisted when the persist fails', async () => {
    const updateRepo = vi.fn().mockResolvedValue(false)
    const { result } = setup({}, updateRepo)
    await act(async () => {
      result.current.updateEnablement(true)
    })
    // A failed save must not leave the toggle showing an unsaved value as if it were saved.
    expect(result.current.displayRepoAi.enabled).toBeUndefined()
    expect(result.current.saveError).toBe('Failed to save Source Control AI settings.')
  })

  it('leaves an action recipe row dirty and retryable when its save fails', async () => {
    const updateRepo = vi.fn().mockResolvedValue(false)
    const { result } = setup(withRecipe('orig'), updateRepo)
    act(() => {
      result.current.updateActionTemplate('fixCommitFailure', 'edited')
    })
    expect(result.current.actionDirtyById.fixCommitFailure).toBe(true)
    await act(async () => {
      await result.current.saveActionRecipeText('fixCommitFailure')
    })
    expect(result.current.actionDirtyById.fixCommitFailure).toBe(true)
    expect(result.current.saveError).toBe('Failed to save Source Control AI settings.')
  })

  it('preserves keystrokes typed while an action save is in flight', async () => {
    let resolveUpdate: (ok: boolean) => void = () => {}
    const updateRepo = vi.fn().mockReturnValue(
      new Promise<boolean>((resolve) => {
        resolveUpdate = resolve
      })
    )
    const { result } = setup(withRecipe('orig'), updateRepo)
    act(() => {
      result.current.updateActionTemplate('fixCommitFailure', 'first')
    })
    let savePromise: Promise<void> = Promise.resolve()
    await act(async () => {
      savePromise = result.current.saveActionRecipeText('fixCommitFailure')
      // flush the queue microtask so updateRepo is called and left pending
      await Promise.resolve()
      await Promise.resolve()
    })
    expect(updateRepo).toHaveBeenCalledTimes(1)
    // user keeps typing while the save is in flight
    act(() => {
      result.current.updateActionTemplate('fixCommitFailure', 'first-and-more')
    })
    await act(async () => {
      resolveUpdate(true)
      await savePromise
    })
    expect(
      result.current.displayRepoAi.actionOverrides?.fixCommitFailure?.commandInputTemplate
    ).toBe('first-and-more')
    expect(result.current.actionDirtyById.fixCommitFailure).toBe(true)
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
    // Completing the previous repo's save must not re-apply its draft onto repo-2.
    expect(
      result.current.displayRepoAi.actionOverrides?.fixCommitFailure?.commandInputTemplate
    ).toBe('repo-2-template')
  })

  it('keeps a successful agent optimistic value when a later enablement persist fails', async () => {
    const updateRepo = vi
      .fn()
      .mockResolvedValueOnce(true) // action mode
      .mockResolvedValueOnce(true) // agent
      .mockResolvedValueOnce(false) // enablement
    const { result } = setup({}, updateRepo)
    await act(async () => {
      result.current.updateActionMode('fixCommitFailure', 'override')
      result.current.updateActionAgent('fixCommitFailure', 'codex')
      result.current.updateEnablement(true)
    })
    // Enablement rolls back; the successfully saved agent override must remain visible.
    expect(result.current.displayRepoAi.enabled).toBeUndefined()
    expect(result.current.displayRepoAi.actionOverrides?.fixCommitFailure?.agentId).toBe('codex')
    expect(result.current.saveError).toBe('Failed to save Source Control AI settings.')
  })
})

// One action edit saves that action complete, through the real serializer, and nothing else.
describe('editing one repository action', () => {
  const base = getDefaultSettings('/tmp')
  const terra = { agentId: 'codex' as const, model: 'gpt-5.6-terra' }
  const global = { agentId: 'codex' as const, commandInputTemplate: 'g', agentArgs: '--global' }
  const actions = {
    fixCommitFailure: { ...global, launchPreferences: terra },
    fixPushFailure: global
  }
  const settings = { ...base, sourceControlAi: { ...base.sourceControlAi!, actions } }
  const reload = (repo: RepoSourceControlAiOverrides, actionId: SourceControlActionId) => {
    const update = toSourceControlAiRepoUpdate(repo)
    const sourceControlAi = update.sourceControlAi ?? undefined
    return resolveSourceControlActionRecipe({ settings, repo: { sourceControlAi }, actionId })
  }
  const editPrompt = (repo: RepoSourceControlAiOverrides, actionId: SourceControlActionId) =>
    withRepoAiActionRecipeText(repo, settings, actionId, {
      ...readActionRecipeTextDraft(repo, actionId),
      commandInputTemplate: 'mine'
    })

  it('keeps a legacy partial row on its agent and empty args when its choice is set or reset', () => {
    const legacy = { actionOverrides: { fixCommitFailure: { agentArgs: '' } } }
    const set = (value?: typeof terra) =>
      reload(
        withRepoAiActionLaunchPreferences(legacy, settings, 'fixCommitFailure', value),
        'fixCommitFailure'
      )
    const luna = { ...terra, model: 'gpt-5.6-luna' }
    expect(set(luna)).toMatchObject({ agentId: 'codex', agentArgs: '', launchPreferences: luna })
    expect(set()).toMatchObject({ agentId: 'codex', agentArgs: '' })
    expect(set().launchPreferences).toBeUndefined()
  })

  it('makes the copied model owned by the action, so it outranks the raw model it yielded to', () => {
    const legacy = { actionOverrides: { fixCommitFailure: { agentArgs: '--model gpt-5.6-sol' } } }
    const stored = {
      settings,
      repo: { sourceControlAi: legacy },
      actionId: 'fixCommitFailure'
    } as const
    expect(resolveSourceControlActionRecipe(stored).launchPreferencesYieldToAgentArgs).toBe(true)
    const edited = reload(editPrompt(legacy, 'fixCommitFailure'), 'fixCommitFailure')
    expect(edited).toMatchObject({ commandInputTemplate: 'mine', launchPreferences: terra })
    expect(edited.launchPreferencesYieldToAgentArgs).toBeUndefined()
  })

  it('saves a prompt edit without authoring args the user never typed or touching a sibling', () => {
    const sibling = { agentArgs: '--repo' }
    const cleared = {
      fixCommitFailure: { agentId: 'codex' as const, agentArgs: null },
      fixPushFailure: sibling
    }
    expect(editPrompt({ actionOverrides: cleared }, 'fixCommitFailure').actionOverrides).toEqual({
      fixCommitFailure: expect.objectContaining({ agentArgs: null, commandInputTemplate: 'mine' }),
      fixPushFailure: sibling
    })
    // Absent args under nonempty Globals: the edited action keeps the args it ran with.
    const absent = { actionOverrides: { fixCommitFailure: { agentId: 'codex' as const } } }
    expect(reload(editPrompt(absent, 'fixCommitFailure'), 'fixCommitFailure').agentArgs).toBe(
      '--global'
    )
  })
})
