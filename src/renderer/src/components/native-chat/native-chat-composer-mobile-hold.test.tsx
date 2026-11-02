// @vitest-environment happy-dom

/** A phone’s input lease must visibly lock the composer and offer Take back regardless of draft contents. */

import { createRef } from 'react'
import { act, cleanup, fireEvent, render, renderHook, screen } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const mocks = vi.hoisted(() => ({
  restoreTerminalFitToDesktop: vi.fn<(ptyId: string, settings: unknown) => Promise<boolean>>(),
  refitAndRefreshAllTerminalPanes: vi.fn(),
  settings: { activeRuntimeEnvironmentId: 'env-1' }
}))

vi.mock('@/i18n/i18n', () => ({
  translate: (_key: string, fallback: string) => fallback
}))
vi.mock('@/store', () => ({
  useAppStore: { getState: () => ({ settings: mocks.settings }) }
}))
vi.mock('../terminal-pane/terminal-fit-restore', () => ({
  restoreTerminalFitToDesktop: mocks.restoreTerminalFitToDesktop
}))
vi.mock('@/lib/pane-manager/pane-manager-registry', () => ({
  refitAndRefreshAllTerminalPanes: mocks.refitAndRefreshAllTerminalPanes
}))
vi.mock('./NativeChatComposerActions', () => ({
  NativeChatComposerActions: () => <div data-testid="composer-actions" />
}))
vi.mock('./NativeChatAutocompleteMenus', () => ({
  NativeChatMentionMenu: () => null,
  NativeChatPickerMenu: () => null
}))

import { NativeChatComposerField } from './NativeChatComposerField'
import type { NativeChatComposerNotice } from './native-chat-composer-notice'
import { useImeEnterGestureOwnership } from '@/lib/ime-composition-keyboard-event'
import {
  nativeChatMobileHoldNotice,
  useNativeChatMobileHoldNotice
} from './use-native-chat-mobile-hold-notice'

beforeEach(() => {
  mocks.restoreTerminalFitToDesktop.mockReset()
  mocks.refitAndRefreshAllTerminalPanes.mockReset()
  vi.stubGlobal('requestAnimationFrame', (callback: () => void) => {
    callback()
    return 0
  })
})

afterEach(() => {
  cleanup()
  vi.unstubAllGlobals()
})

function HeldField({
  notices,
  goalActive
}: {
  notices: readonly NativeChatComposerNotice[]
  goalActive: boolean
}): React.JSX.Element {
  const imeEnterGesture = useImeEnterGestureOwnership()
  return (
    <NativeChatComposerField
      draftScopeKey="pane-held"
      textareaRef={createRef<HTMLTextAreaElement>()}
      draft="half-written reply"
      disabled
      hasPty
      canSend={false}
      autocomplete={{ mode: 'none' }}
      activeSuggestion={0}
      notices={notices}
      imageAttachments={[]}
      sendButtonDisabled
      isWorking={false}
      attachDisabled
      dictationDisabled
      isDictating={false}
      isDictationHoldMode={false}
      imeEnterGesture={imeEnterGesture}
      goalMode={{ active: goalActive, exit: vi.fn(), interceptPick: (pick) => pick }}
      onDraftChange={vi.fn()}
      onTextareaSelect={vi.fn()}
      onKeyDown={vi.fn()}
      onImeSettled={vi.fn()}
      onPaste={vi.fn()}
      pickerListboxId="picker"
      onChoosePickerItem={vi.fn()}
      onRetrySkills={vi.fn()}
      onChooseMentionFile={vi.fn()}
      mentionFiles={{ files: [], loading: false, failed: false }}
      onRemoveImageAttachment={vi.fn()}
      onAttach={vi.fn()}
      onDictationToggle={vi.fn()}
      onDictationHoldStart={vi.fn()}
      onDictationHoldEnd={vi.fn()}
      onSend={vi.fn()}
      sessionOptionsSurface={null}
      sessionOptionsSnapshot={[]}
    />
  )
}

describe('the chat composer while a phone holds the input', () => {
  it('names the lock and offers Take back with a draft and goal mode on', () => {
    const onTakeBack = vi.fn()
    render(<HeldField notices={[nativeChatMobileHoldNotice(false, onTakeBack)]} goalActive />)

    expect(screen.getByText('Input is held by another device.')).toBeTruthy()
    fireEvent.click(screen.getByRole('button', { name: 'Take back' }))
    expect(onTakeBack).toHaveBeenCalledTimes(1)
  })
})

describe('useNativeChatMobileHoldNotice', () => {
  it("runs the terminal's reclaim for this pty and refits once it lands", async () => {
    let resolveRestore: (restored: boolean) => void = () => {}
    mocks.restoreTerminalFitToDesktop.mockReturnValue(
      new Promise<boolean>((resolve) => {
        resolveRestore = resolve
      })
    )
    const { result } = renderHook(() => useNativeChatMobileHoldNotice('pty-1', false))
    expect(result.current?.kind).toBe('device')
    expect(result.current?.action?.disabled).toBe(false)

    act(() => result.current?.action?.onClick())
    expect(mocks.restoreTerminalFitToDesktop).toHaveBeenCalledWith('pty-1', mocks.settings)
    // Pending blocks a second reclaim while the first is in flight.
    expect(result.current?.action?.disabled).toBe(true)

    await act(async () => resolveRestore(true))
    expect(mocks.refitAndRefreshAllTerminalPanes).toHaveBeenCalledTimes(1)
    expect(result.current?.action?.disabled).toBe(false)
  })

  it('leaves the panes alone when there was nothing to reclaim', async () => {
    mocks.restoreTerminalFitToDesktop.mockResolvedValue(false)
    const { result } = renderHook(() => useNativeChatMobileHoldNotice('pty-1', false))

    await act(async () => result.current?.action?.onClick())
    expect(mocks.refitAndRefreshAllTerminalPanes).not.toHaveBeenCalled()
    expect(result.current?.action?.disabled).toBe(false)
  })
})
