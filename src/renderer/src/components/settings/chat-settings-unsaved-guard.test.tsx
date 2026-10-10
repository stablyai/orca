// @vitest-environment happy-dom
import { act, cleanup, renderHook } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { getDefaultSettings } from '../../../../shared/constants'
import {
  useSettingsInteractionController,
  type SettingsInteractionModel
} from './use-settings-interaction-controller'
import { useSettingsNavigationActions } from './settings-view-model'

afterEach(cleanup)

function createModel(shouldDiscard = false, dirty = true) {
  return {
    closeSettingsPage: vi.fn(),
    confirm: vi.fn(async () => shouldDiscard),
    hasUnsavedBranchPromptChanges: false,
    hasUnsavedCommitPromptChanges: false,
    hasUnsavedChatPromptChanges: dirty,
    highlightedSettingsTargetId: null,
    setFontSuggestions: vi.fn(),
    setHasUnsavedBranchPromptChanges: vi.fn(),
    setHasUnsavedCommitPromptChanges: vi.fn(),
    setHasUnsavedChatPromptChanges: vi.fn(),
    setHighlightedSettingsTargetId: vi.fn(),
    setSettingsSearchQuery: vi.fn(),
    setSourceControlAiPromptDiscardSignal: vi.fn(),
    settings: getDefaultSettings('/tmp'),
    updateSettingsOrThrow: vi.fn(async () => {}),
    activeSectionId: 'chat',
    setActiveSectionId: vi.fn(),
    setPendingNavRequestTick: vi.fn(),
    settingsSearchQuery: ''
  } satisfies SettingsInteractionModel & Parameters<typeof useSettingsNavigationActions>[0]
}

function renderController(model: ReturnType<typeof createModel>) {
  return renderHook(() => {
    const interactions = useSettingsInteractionController(model)
    const navigation = useSettingsNavigationActions(model, interactions)
    return { ...interactions, ...navigation }
  })
}

describe('Chat settings unsaved guard', () => {
  it('asks before closing with a dirty chat recipe and keeps the page open when cancelled', async () => {
    const model = createModel()
    const { result } = renderController(model)
    await act(async () => result.current.closeSettingsPageWithPromptGuard())
    expect(model.confirm).toHaveBeenCalledWith(
      expect.objectContaining({ title: 'Discard unsaved AI settings?' })
    )
    expect(model.closeSettingsPage).not.toHaveBeenCalled()
    expect(model.setHasUnsavedChatPromptChanges).not.toHaveBeenCalled()
    expect(model.setSourceControlAiPromptDiscardSignal).not.toHaveBeenCalled()
  })

  it('clears the chat draft through the existing discard signal before closing', async () => {
    const model = createModel(true)
    const { result } = renderController(model)
    await act(async () => result.current.closeSettingsPageWithPromptGuard())
    expect(model.confirm).toHaveBeenCalledOnce()
    expect(model.setSourceControlAiPromptDiscardSignal).toHaveBeenCalledOnce()
    expect(model.setHasUnsavedChatPromptChanges).toHaveBeenCalledWith(false)
    expect(model.closeSettingsPage).toHaveBeenCalledOnce()
  })

  it('guards settings navigation with the same dirty chat recipe', async () => {
    const model = createModel()
    const { result } = renderController(model)
    await act(async () => result.current.scrollToSection('git'))
    expect(model.confirm).toHaveBeenCalledOnce()
    expect(model.setActiveSectionId).not.toHaveBeenCalled()
    expect(model.setSourceControlAiPromptDiscardSignal).not.toHaveBeenCalled()
  })

  it('closes without asking when the recipe is clean', async () => {
    const model = createModel(false, false)
    const { result } = renderController(model)
    await act(async () => result.current.closeSettingsPageWithPromptGuard())
    expect(model.confirm).not.toHaveBeenCalled()
    expect(model.closeSettingsPage).toHaveBeenCalledOnce()
  })
})
