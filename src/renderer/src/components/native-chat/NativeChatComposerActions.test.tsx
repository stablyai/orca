// @vitest-environment happy-dom

import { act, cleanup, fireEvent, render, renderHook, screen } from '@testing-library/react'
import type { ReactNode } from 'react'
import { afterEach, describe, expect, it, vi } from 'vitest'

const voice = vi.hoisted(() => ({
  dictationState: 'idle',
  settings: { voice: { enabled: true, sttModel: 'configured' } }
}))
vi.mock('../../store', () => ({
  useAppStore: (selector: (state: typeof voice) => unknown) => selector(voice)
}))
vi.mock('../dictation/dictation-control-events', () => ({ dispatchDictationControl: vi.fn() }))

vi.mock('@/i18n/i18n', () => ({
  translate: (_key: string, fallback: string) => fallback
}))

vi.mock('@/components/ui/button', () => ({
  Button: ({
    children,
    variant: _variant,
    size: _size,
    ...props
  }: {
    children: ReactNode
    variant?: string
    size?: string
  } & React.ButtonHTMLAttributes<HTMLButtonElement>) => <button {...props}>{children}</button>
}))

vi.mock('@/components/ui/tooltip', () => ({
  Tooltip: ({ children }: { children: ReactNode }) => <>{children}</>,
  TooltipTrigger: ({ children }: { children: ReactNode }) => <>{children}</>,
  TooltipContent: ({ children }: { children: ReactNode }) => <div>{children}</div>
}))

vi.mock('./NativeChatSessionOptionPickers', () => ({
  NativeChatSessionOptionPickers: () => <div data-testid="session-option-pickers" />
}))

import { NativeChatComposerActions } from './NativeChatComposerActions'
import { useNativeChatDictation } from './use-native-chat-dictation'
import { dispatchDictationControl } from '../dictation/dictation-control-events'

afterEach(() => {
  cleanup()
  voice.dictationState = 'idle'
  vi.clearAllMocks()
})

describe('NativeChatComposerActions', () => {
  it.each([false, true])(
    'sends a draft while working, then shows Stop after it clears (stopping: %s)',
    (isStopping) => {
      const onSend = vi.fn()
      const onStop = vi.fn()
      const props = {
        attachDisabled: false,
        dictationDisabled: false,
        sendDisabled: false,
        isWorking: true,
        isStopping,
        isDictating: false,
        isDictationHoldMode: false,
        onAttach: vi.fn(),
        onDictationToggle: vi.fn(),
        onDictationHoldStart: vi.fn(),
        onDictationHoldEnd: vi.fn(),
        onSend,
        onStop,
        sessionOptionsSurface: null,
        sessionOptionsSnapshot: []
      }
      const view = render(<NativeChatComposerActions {...props} hasContent />)
      const send = screen.getByRole('button', { name: 'Send' })
      expect(send.hasAttribute('disabled')).toBe(false)
      expect(send.hasAttribute('data-native-chat-critical-action')).toBe(false)
      fireEvent.click(send)
      expect(onSend).toHaveBeenCalledOnce()
      expect(onStop).not.toHaveBeenCalled()

      view.rerender(<NativeChatComposerActions {...props} hasContent={false} />)
      const stop = screen.getByRole('button', {
        name: isStopping ? 'Stopping…' : 'Stop the agent'
      })
      expect(stop.getAttribute('data-native-chat-critical-action')).toBe('stop')
      expect(stop.hasAttribute('disabled')).toBe(isStopping)
      // A second click from the original double-click must not stop the turn.
      fireEvent.click(stop, { detail: 2 })
      expect(onStop).not.toHaveBeenCalled()
      fireEvent.click(stop, { detail: 1 })
      expect(onStop).toHaveBeenCalledTimes(isStopping ? 0 : 1)
    }
  )

  it.each(['starting', 'listening'])('blocks new dictation but preserves %s Stop', (state) => {
    const input = document.createElement('textarea')
    const focus = vi.spyOn(input, 'focus')
    const { result, rerender } = renderHook(
      (disabled: boolean) => useNativeChatDictation({ current: input }, disabled),
      { initialProps: true }
    )
    act(() => {
      result.current.toggleDictation()
      result.current.startHoldDictation()
    })
    expect(dispatchDictationControl).not.toHaveBeenCalled()
    rerender(false)
    act(() => result.current.startHoldDictation())
    expect(dispatchDictationControl).toHaveBeenLastCalledWith('start')
    voice.dictationState = state
    rerender(true)
    expect(result.current.dictationDisabled).toBe(false)
    focus.mockClear()
    act(() => {
      result.current.toggleDictation()
      result.current.stopHoldDictation()
    })
    expect(dispatchDictationControl).toHaveBeenLastCalledWith('stop')
    expect(focus).not.toHaveBeenCalled()
  })

  it("disables the Stop control and names it Stopping while a person's Stop is ending the turn", () => {
    const props = {
      hasContent: false,
      attachDisabled: false,
      dictationDisabled: false,
      isWorking: true,
      isDictating: false,
      isDictationHoldMode: false,
      onAttach: vi.fn(),
      onDictationToggle: vi.fn(),
      onDictationHoldStart: vi.fn(),
      onDictationHoldEnd: vi.fn(),
      onSend: vi.fn(),
      sessionOptionsSurface: null,
      sessionOptionsSnapshot: []
    }
    const { rerender } = render(<NativeChatComposerActions {...props} sendDisabled={false} />)
    expect(screen.getByRole('button', { name: 'Stop the agent' })).toBeTruthy()

    rerender(<NativeChatComposerActions {...props} sendDisabled={false} isStopping />)

    expect(screen.getByRole('button', { name: 'Stopping…' }).hasAttribute('disabled')).toBe(true)
  })

  it('marks the streaming Stop control as the critical hit target', () => {
    render(
      <NativeChatComposerActions
        hasContent={false}
        attachDisabled={false}
        dictationDisabled={false}
        sendDisabled={false}
        isWorking
        isDictating={false}
        isDictationHoldMode={false}
        onAttach={vi.fn()}
        onDictationToggle={vi.fn()}
        onDictationHoldStart={vi.fn()}
        onDictationHoldEnd={vi.fn()}
        onSend={vi.fn()}
        onStop={vi.fn()}
        sessionOptionsSurface={null}
        sessionOptionsSnapshot={[]}
      />
    )

    expect(
      screen
        .getByRole('button', { name: 'Stop the agent' })
        .getAttribute('data-native-chat-critical-action')
    ).toBe('stop')
  })

  it('ignores the second click of a double-click after send becomes Stop', () => {
    const onSend = vi.fn()
    const onStop = vi.fn()
    render(
      <NativeChatComposerActions
        hasContent={false}
        attachDisabled={false}
        dictationDisabled={false}
        sendDisabled={false}
        isWorking
        isDictating={false}
        isDictationHoldMode={false}
        onAttach={vi.fn()}
        onDictationToggle={vi.fn()}
        onDictationHoldStart={vi.fn()}
        onDictationHoldEnd={vi.fn()}
        onSend={onSend}
        onStop={onStop}
        sessionOptionsSurface={null}
        sessionOptionsSnapshot={[]}
      />
    )

    fireEvent.click(screen.getByRole('button', { name: 'Stop the agent' }), { detail: 2 })

    expect(onSend).not.toHaveBeenCalled()
    expect(onStop).not.toHaveBeenCalled()
  })

  it.each([false, true])(
    'a press on Send or Stop leaves focus where it was (working: %s)',
    (isWorking) => {
      render(
        <NativeChatComposerActions
          hasContent={false}
          attachDisabled={false}
          dictationDisabled={false}
          sendDisabled={false}
          isWorking={isWorking}
          isDictating={false}
          isDictationHoldMode={false}
          onAttach={vi.fn()}
          onDictationToggle={vi.fn()}
          onDictationHoldStart={vi.fn()}
          onDictationHoldEnd={vi.fn()}
          onSend={vi.fn()}
          onStop={vi.fn()}
          sessionOptionsSurface={null}
          sessionOptionsSnapshot={[]}
        />
      )

      const button = screen.getByRole('button', { name: isWorking ? 'Stop the agent' : 'Send' })
      // fireEvent returns false when the default (moving focus to the button) was prevented.
      expect(fireEvent.mouseDown(button)).toBe(false)
    }
  )

  it('says on the disabled send button what to do to send', () => {
    render(
      <NativeChatComposerActions
        hasContent={false}
        attachDisabled={false}
        dictationDisabled={false}
        sendDisabled
        sendBlockedReason="An image couldn't be brought back. Remove it to send."
        isWorking={false}
        isDictating={false}
        isDictationHoldMode={false}
        onAttach={vi.fn()}
        onDictationToggle={vi.fn()}
        onDictationHoldStart={vi.fn()}
        onDictationHoldEnd={vi.fn()}
        onSend={vi.fn()}
        sessionOptionsSurface={null}
        sessionOptionsSnapshot={[]}
      />
    )

    const send = screen.getByRole('button', {
      name: "An image couldn't be brought back. Remove it to send."
    })
    expect(send.hasAttribute('disabled')).toBe(true)
  })

  it('marks a draft that could not be saved only after storage refused it', () => {
    const props = {
      hasContent: false,
      attachDisabled: false,
      dictationDisabled: false,
      sendDisabled: false,
      isWorking: false,
      isDictating: false,
      isDictationHoldMode: false,
      onAttach: vi.fn(),
      onDictationToggle: vi.fn(),
      onDictationHoldStart: vi.fn(),
      onDictationHoldEnd: vi.fn(),
      onSend: vi.fn(),
      sessionOptionsSurface: null,
      sessionOptionsSnapshot: []
    }
    const explanation = "This draft couldn't be saved yet. Orca keeps trying."
    const { rerender } = render(<NativeChatComposerActions {...props} />)
    expect(screen.queryByRole('img', { name: explanation })).toBeNull()

    rerender(<NativeChatComposerActions {...props} draftNotSaved />)
    expect(screen.getByRole('img', { name: explanation })).toBeTruthy()
    expect(screen.getByRole('button', { name: 'Send' }).hasAttribute('disabled')).toBe(false)
  })
})
