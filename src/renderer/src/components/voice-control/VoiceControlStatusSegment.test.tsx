// @vitest-environment happy-dom

import { act, cleanup, fireEvent, render, screen } from '@testing-library/react'
import type { ReactNode } from 'react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { VOICE_CONTROL_ACTION_EVENT, type VoiceControlAction } from './voice-control-events'
import { publishVoiceControlState, resetVoiceControl } from './voice-control-store'

vi.mock('@/i18n/i18n', () => ({
  translate: (_key: string, fallback: string) => fallback
}))

vi.mock('@/components/ui/tooltip', () => ({
  Tooltip: ({ children }: { children: ReactNode }) => <>{children}</>,
  TooltipTrigger: ({ children }: { children: ReactNode }) => <>{children}</>,
  TooltipContent: ({ children }: { children: ReactNode }) => <>{children}</>
}))

import { VoiceControlStatusSegment } from './VoiceControlStatusSegment'

function isControlEvent(event: Event): event is CustomEvent<VoiceControlAction> {
  return (
    event instanceof CustomEvent &&
    (event.detail === 'toggle' || event.detail === 'start' || event.detail === 'stop')
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
  act(() => resetVoiceControl())
})

afterEach(() => {
  cleanup()
})

describe('VoiceControlStatusSegment', () => {
  it('renders nothing while idle', () => {
    const { container } = render(<VoiceControlStatusSegment iconOnly={false} />)

    expect(container.firstChild).toBeNull()
  })

  it('shows Live while the session is live and stops it on click', () => {
    const { actions, stop } = collectControlActions()
    render(<VoiceControlStatusSegment iconOnly={false} />)
    act(() => publishVoiceControlState({ sessionId: 's1', state: 'live' }))

    const button = screen.getByRole('button', {
      name: 'Voice control is live with the mic open. Click to stop.'
    })
    expect(button.textContent).toContain('Live')
    fireEvent.click(button)

    stop()
    expect(actions).toEqual(['stop'])
  })

  it('shows Connecting… while minting and awaiting the SDP answer', () => {
    render(<VoiceControlStatusSegment iconOnly={false} />)
    act(() => publishVoiceControlState({ sessionId: 's1', state: 'minting' }))
    expect(screen.getByTestId('voice-control-status-segment').textContent).toContain('Connecting…')
    act(() => publishVoiceControlState({ sessionId: 's1', state: 'awaiting-sdp' }))
    expect(screen.getByTestId('voice-control-status-segment').textContent).toContain('Connecting…')
  })

  it('shows Stopping… while the session is stopping', () => {
    render(<VoiceControlStatusSegment iconOnly={false} />)
    act(() => publishVoiceControlState({ sessionId: 's1', state: 'stopping' }))

    expect(screen.getByTestId('voice-control-status-segment').textContent).toContain('Stopping…')
  })

  it('shows Error with the destructive treatment and dispatches stop to reset on click', () => {
    const { actions, stop } = collectControlActions()
    render(<VoiceControlStatusSegment iconOnly={false} />)
    act(() => publishVoiceControlState({ sessionId: 's1', state: 'error', errorKind: 'network' }))

    const button = screen.getByRole('button', {
      name: 'Voice control error. Click to stop and reset.'
    })
    expect(button.textContent).toContain('Error')
    expect(button.className).toContain('text-destructive')
    fireEvent.click(button)

    stop()
    expect(actions).toEqual(['stop'])
  })

  it('hides again once the session returns to idle', () => {
    const { container } = render(<VoiceControlStatusSegment iconOnly={false} />)
    act(() => publishVoiceControlState({ sessionId: 's1', state: 'live' }))
    expect(screen.queryByTestId('voice-control-status-segment')).not.toBeNull()

    act(() => publishVoiceControlState({ sessionId: null, state: 'idle' }))
    expect(container.firstChild).toBeNull()
  })

  it('keeps the label out of the segment in icon-only density', () => {
    render(<VoiceControlStatusSegment iconOnly={true} />)
    act(() => publishVoiceControlState({ sessionId: 's1', state: 'live' }))

    const segment = screen.getByTestId('voice-control-status-segment')
    expect(segment.textContent).not.toContain('Live')
  })
})
