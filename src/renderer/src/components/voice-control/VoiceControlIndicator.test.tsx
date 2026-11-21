// @vitest-environment happy-dom

import { act, cleanup, fireEvent, render, screen } from '@testing-library/react'
import type { ReactNode } from 'react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { VOICE_CONTROL_ACTION_EVENT, type VoiceControlAction } from './voice-control-events'
import {
  publishVoiceControlMicMuted,
  publishVoiceControlState,
  resetVoiceControl
} from './voice-control-store'

vi.mock('@/i18n/i18n', () => ({
  translate: (_key: string, fallback: string) => fallback
}))

vi.mock('@/components/ui/tooltip', () => ({
  Tooltip: ({ children }: { children: ReactNode }) => <>{children}</>,
  TooltipTrigger: ({ children }: { children: ReactNode }) => <>{children}</>,
  TooltipContent: ({ children }: { children: ReactNode }) => <>{children}</>
}))

const { useAppStoreMock } = vi.hoisted(() => ({ useAppStoreMock: vi.fn() }))
vi.mock('@/store', () => ({ useAppStore: useAppStoreMock }))

import { VoiceControlIndicator } from './VoiceControlIndicator'

function isControlEvent(event: Event): event is CustomEvent<VoiceControlAction> {
  return (
    event instanceof CustomEvent &&
    (event.detail === 'toggle' ||
      event.detail === 'start' ||
      event.detail === 'stop' ||
      event.detail === 'toggle-mute')
  )
}

function collectControlActions(): {
  actions: VoiceControlAction[]
  stop: () => void
} {
  const actions: VoiceControlAction[] = []
  const listener = (event: Event): void => {
    if (isControlEvent(event)) {
      actions.push(event.detail)
    }
  }
  document.addEventListener(VOICE_CONTROL_ACTION_EVENT, listener)
  return {
    actions,
    stop: () => document.removeEventListener(VOICE_CONTROL_ACTION_EVENT, listener)
  }
}

beforeEach(() => {
  useAppStoreMock.mockImplementation((selector: (state: unknown) => unknown) =>
    selector({
      keybindings: undefined,
      openSettingsPage: vi.fn(),
      openSettingsTarget: vi.fn(),
      setSettingsSearchQuery: vi.fn()
    })
  )
  act(() => resetVoiceControl())
})

afterEach(() => {
  cleanup()
})

describe('VoiceControlIndicator', () => {
  it('offers mic mute beside stop while live, dispatching toggle-mute on click', () => {
    const { actions, stop } = collectControlActions()
    render(<VoiceControlIndicator />)
    act(() => publishVoiceControlState({ sessionId: 's1', state: 'live' }))

    const mute = screen.getByRole('button', { name: 'Mute microphone' })
    expect(mute.getAttribute('aria-pressed')).toBe('false')
    expect(screen.getByRole('button', { name: 'Stop voice control' })).toBeTruthy()
    fireEvent.click(mute)

    stop()
    expect(actions).toEqual(['toggle-mute'])
  })

  it('reflects the muted state with the unmute label and pressed styling hook', () => {
    render(<VoiceControlIndicator />)
    act(() => {
      publishVoiceControlState({ sessionId: 's1', state: 'live' })
      publishVoiceControlMicMuted(true)
    })

    const mute = screen.getByRole('button', { name: 'Unmute microphone' })
    expect(mute.getAttribute('aria-pressed')).toBe('true')
  })

  it('hides the mute toggle until the session is live', () => {
    render(<VoiceControlIndicator />)
    expect(screen.queryByRole('button', { name: 'Mute microphone' })).toBeNull()

    act(() => publishVoiceControlState({ sessionId: 's1', state: 'minting' }))
    expect(screen.queryByRole('button', { name: 'Mute microphone' })).toBeNull()

    act(() => publishVoiceControlState({ sessionId: 's1', state: 'live' }))
    expect(screen.getByRole('button', { name: 'Mute microphone' })).toBeTruthy()
  })
})
