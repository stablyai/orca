// @vitest-environment happy-dom

import { act, cleanup, renderHook } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { toast } from 'sonner'
import {
  SHORTCUTS_ESCAPE_CONFIRM_TOAST_ID,
  SHORTCUTS_ESCAPE_CONFIRM_WINDOW_MS
} from './settings-navigation-foundations'
import { useSettingsPageEffects } from './use-settings-page-effects'
import type { SettingsInteractionController } from './use-settings-interaction-controller'
import type { SettingsStoreModel } from './use-settings-store-model'

vi.mock('sonner', () => ({
  toast: {
    dismiss: vi.fn(),
    info: vi.fn()
  }
}))

function createSettingsModel(overrides: Partial<SettingsStoreModel> = {}): SettingsStoreModel {
  return {
    activeSectionId: 'general',
    clearSettingsTarget: vi.fn(),
    fetchKeybindings: vi.fn(),
    fetchSettings: vi.fn(),
    keybindings: {},
    refreshModelStates: vi.fn().mockResolvedValue(undefined),
    repoIdToHostSelection: new Map(),
    repoIdToRepresentative: new Map(),
    setHighlightedSettingsTargetId: vi.fn(),
    setMountedSectionIds: vi.fn(),
    setPendingNavRequestTick: vi.fn(),
    setQuickCommandAddIntentSignal: vi.fn(),
    setRemoteServerAddIntentSignal: vi.fn(),
    setSettingsProjectHostSelection: vi.fn(),
    setSshHostAddIntentSignal: vi.fn(),
    setVoiceModelStatesLoading: vi.fn(),
    settings: null,
    settingsNavigationTarget: null,
    settingsProjectList: [],
    showDesktopOnlySettings: false,
    ...overrides
  } as unknown as SettingsStoreModel
}

function createSettingsInteractions(
  overrides: Partial<SettingsInteractionController> = {}
): SettingsInteractionController {
  return {
    closeSettingsPageWithPromptGuard: vi.fn().mockResolvedValue(undefined),
    hasUnsavedSourceControlAiPromptChangesRef: { current: false },
    pendingNavSectionRef: { current: null },
    pendingScrollTargetRef: { current: null },
    promptDiscardSourceControlAiPromptChanges: vi.fn().mockResolvedValue(true),
    searchInputRef: { current: null },
    shortcutsEscapeConfirmUntilRef: { current: 0 },
    ...overrides
  } as unknown as SettingsInteractionController
}

function focusTextInput(): HTMLInputElement {
  const input = document.createElement('input')
  document.body.append(input)
  input.focus()
  return input
}

function createEscapeEvent(overrides: KeyboardEventInit = {}): KeyboardEvent {
  return new KeyboardEvent('keydown', {
    bubbles: true,
    cancelable: true,
    key: 'Escape',
    ...overrides
  })
}

function dispatchEscape(target: EventTarget, overrides: KeyboardEventInit = {}): KeyboardEvent {
  const event = createEscapeEvent(overrides)
  target.dispatchEvent(event)
  return event
}

afterEach(() => {
  cleanup()
  document.body.innerHTML = ''
  vi.restoreAllMocks()
})

describe('useSettingsPageEffects Escape handling', () => {
  it('closes Settings when Escape starts from the focused search field', () => {
    const closeSettingsPageWithPromptGuard = vi.fn().mockResolvedValue(undefined)
    const input = focusTextInput()

    renderHook(() =>
      useSettingsPageEffects(
        createSettingsModel(),
        createSettingsInteractions({ closeSettingsPageWithPromptGuard })
      )
    )

    act(() => {
      dispatchEscape(input)
    })

    expect(closeSettingsPageWithPromptGuard).toHaveBeenCalledOnce()
  })

  it('does not close Settings when IME composition owns Escape', () => {
    const closeSettingsPageWithPromptGuard = vi.fn().mockResolvedValue(undefined)
    const input = focusTextInput()

    renderHook(() =>
      useSettingsPageEffects(
        createSettingsModel(),
        createSettingsInteractions({ closeSettingsPageWithPromptGuard })
      )
    )

    act(() => {
      const event = createEscapeEvent()
      Object.defineProperty(event, 'isComposing', { value: true })
      input.dispatchEvent(event)
    })

    expect(closeSettingsPageWithPromptGuard).not.toHaveBeenCalled()
  })

  it('does not close Settings when a child control already handled Escape', () => {
    const closeSettingsPageWithPromptGuard = vi.fn().mockResolvedValue(undefined)
    const input = focusTextInput()

    renderHook(() =>
      useSettingsPageEffects(
        createSettingsModel(),
        createSettingsInteractions({ closeSettingsPageWithPromptGuard })
      )
    )

    act(() => {
      const event = createEscapeEvent()
      event.preventDefault()
      input.dispatchEvent(event)
    })

    expect(closeSettingsPageWithPromptGuard).not.toHaveBeenCalled()
  })

  it('keeps the Shortcuts page double-Escape guard when focus starts in an input', () => {
    const closeSettingsPageWithPromptGuard = vi.fn().mockResolvedValue(undefined)
    const shortcutsEscapeConfirmUntilRef = { current: 0 }
    const input = focusTextInput()
    vi.spyOn(Date, 'now').mockReturnValue(10_000)

    renderHook(() =>
      useSettingsPageEffects(
        createSettingsModel({ activeSectionId: 'shortcuts' }),
        createSettingsInteractions({
          closeSettingsPageWithPromptGuard,
          shortcutsEscapeConfirmUntilRef
        })
      )
    )

    const firstEscape = createEscapeEvent()
    act(() => {
      input.dispatchEvent(firstEscape)
    })

    expect(firstEscape.defaultPrevented).toBe(true)
    expect(closeSettingsPageWithPromptGuard).not.toHaveBeenCalled()
    expect(shortcutsEscapeConfirmUntilRef.current).toBe(10_000 + SHORTCUTS_ESCAPE_CONFIRM_WINDOW_MS)
    expect(toast.info).toHaveBeenCalledWith('Press ESC again to exit settings', {
      className: 'whitespace-nowrap',
      duration: SHORTCUTS_ESCAPE_CONFIRM_WINDOW_MS,
      id: SHORTCUTS_ESCAPE_CONFIRM_TOAST_ID
    })

    const secondEscape = createEscapeEvent()
    act(() => {
      input.dispatchEvent(secondEscape)
    })

    expect(secondEscape.defaultPrevented).toBe(true)
    expect(shortcutsEscapeConfirmUntilRef.current).toBe(0)
    expect(toast.dismiss).toHaveBeenCalledWith(SHORTCUTS_ESCAPE_CONFIRM_TOAST_ID)
    expect(closeSettingsPageWithPromptGuard).toHaveBeenCalledOnce()
  })
})
