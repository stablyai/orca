// @vitest-environment happy-dom

import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import type { ReactNode } from 'react'
import { afterEach, describe, expect, it, vi } from 'vitest'

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

afterEach(() => cleanup())

describe('NativeChatComposerActions', () => {
  it("disables the Stop control and names it Stopping while a person's Stop is ending the turn", () => {
    const props = {
      attachDisabled: false,
      dictationDisabled: false,
      primaryAction: 'stop' as const,
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

  it('places session option pickers immediately beside dictation', () => {
    render(
      <NativeChatComposerActions
        attachDisabled={false}
        dictationDisabled={false}
        sendDisabled={false}
        primaryAction="send"
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

    const pickers = screen.getByTestId('session-option-pickers')
    const dictation = screen.getByRole('button', { name: 'Start dictation' })
    expect(pickers.nextElementSibling).toBe(dictation)
  })

  it('marks the streaming Stop control as the critical hit target', () => {
    render(
      <NativeChatComposerActions
        attachDisabled={false}
        dictationDisabled={false}
        sendDisabled={false}
        primaryAction="stop"
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
        attachDisabled={false}
        dictationDisabled={false}
        sendDisabled={false}
        primaryAction="stop"
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

  it('says on the disabled send button what to do to send', () => {
    render(
      <NativeChatComposerActions
        attachDisabled={false}
        dictationDisabled={false}
        sendDisabled
        primaryAction="send"
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
      attachDisabled: false,
      dictationDisabled: false,
      sendDisabled: false,
      primaryAction: 'send' as const,
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

  describe('Resume of a held queue', () => {
    function renderPrimary(isWorking: boolean, onResume: (() => void) | undefined) {
      const callbacks = { onSend: vi.fn(), onStop: vi.fn() }
      render(
        <NativeChatComposerActions
          attachDisabled={false}
          dictationDisabled={false}
          sendDisabled={false}
          primaryAction={isWorking ? 'stop' : onResume ? 'resume' : 'send'}
          isWorking={isWorking}
          isDictating={false}
          isDictationHoldMode={false}
          onAttach={vi.fn()}
          onDictationToggle={vi.fn()}
          onDictationHoldStart={vi.fn()}
          onDictationHoldEnd={vi.fn()}
          {...callbacks}
          {...(onResume ? { onResume } : {})}
          sessionOptionsSurface={null}
          sessionOptionsSnapshot={[]}
        />
      )
      return callbacks
    }

    it("takes Send's place: one press resumes, never sends", () => {
      const onResume = vi.fn()
      const { onSend } = renderPrimary(false, onResume)
      expect(screen.queryByRole('button', { name: 'Send' })).toBeNull()
      const resume = screen.getByRole('button', { name: 'Resume' })
      fireEvent.click(resume, { detail: 1 })
      fireEvent.click(resume, { detail: 2 })
      expect(onResume).toHaveBeenCalledTimes(1)
      expect(onSend).not.toHaveBeenCalled()
    })

    it('is Send without it, and Stop while a turn runs', () => {
      renderPrimary(false, undefined)
      expect(screen.getByRole('button', { name: 'Send' })).toBeTruthy()
      cleanup()
      const onResume = vi.fn()
      const { onStop } = renderPrimary(true, onResume)
      expect(screen.queryByRole('button', { name: 'Resume' })).toBeNull()
      fireEvent.click(screen.getByRole('button', { name: 'Stop the agent' }), { detail: 1 })
      expect(onStop).toHaveBeenCalledTimes(1)
      expect(onResume).not.toHaveBeenCalled()
    })
  })
})
