// @vitest-environment happy-dom

import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import type { ReactNode } from 'react'
import { createPortal } from 'react-dom'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { DictationState } from '../../../../shared/speech-types'
import { DICTATION_CONTROL_EVENT, type DictationControlAction } from './dictation-control-events'

const storeState = {
  dictationState: 'listening' as DictationState,
  partialTranscript: '',
  dictationMeter: {
    level: 0,
    isSpeaking: false,
    isClipping: false
  },
  settings: { voice: { dictationMode: 'toggle' } } as {
    voice?: { dictationMode?: 'toggle' | 'hold' }
  } | null
}

vi.mock('@/store', () => {
  const useAppStore = (selector: (value: typeof storeState) => unknown) => selector(storeState)
  return { useAppStore }
})

vi.mock('./dictation-meter-store', () => ({
  useDictationMeter: () => storeState.dictationMeter
}))

vi.mock('@/i18n/i18n', () => ({
  translate: (_key: string, fallback: string) => fallback
}))

// Why: the real TooltipContent portals out of the trigger's subtree. The mock must
// too, or "the pill itself does not render the chip" would pass vacuously.
vi.mock('@/components/ui/tooltip', () => ({
  Tooltip: ({ children }: { children: ReactNode }) => <>{children}</>,
  TooltipTrigger: ({ children }: { children: ReactNode }) => <>{children}</>,
  TooltipContent: ({ children }: { children: ReactNode }) =>
    createPortal(<div data-testid="tooltip-content">{children}</div>, document.body)
}))

import { DictationIndicator } from './DictationIndicator'

function setUserAgent(userAgent: string): void {
  Object.defineProperty(navigator, 'userAgent', { configurable: true, value: userAgent })
}

const originalUserAgent = navigator.userAgent

beforeEach(() => {
  storeState.dictationState = 'listening'
  storeState.partialTranscript = ''
  storeState.dictationMeter = {
    level: 0,
    isSpeaking: false,
    isClipping: false
  }
  storeState.settings = { voice: { dictationMode: 'toggle' } }
  setUserAgent('Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7)')
})

afterEach(() => {
  cleanup()
  setUserAgent(originalUserAgent)
})

describe('DictationIndicator', () => {
  it('stops dictation when the stop button is clicked', () => {
    const actions: DictationControlAction[] = []
    const listener = (event: Event): void => {
      actions.push((event as CustomEvent<DictationControlAction>).detail)
    }
    document.addEventListener(DICTATION_CONTROL_EVENT, listener)

    render(<DictationIndicator />)
    fireEvent.click(screen.getByRole('button', { name: 'Stop dictation' }))

    document.removeEventListener(DICTATION_CONTROL_EVENT, listener)
    expect(actions).toEqual(['stop'])
  })

  it('keeps focus on the dictation target when the stop button is pressed', () => {
    render(<DictationIndicator />)
    const stopButton = screen.getByRole('button', { name: 'Stop dictation' })

    expect(fireEvent.mouseDown(stopButton)).toBe(false)
  })

  it('shows the assigned shortcut in the stop button tooltip in toggle mode', () => {
    render(<DictationIndicator />)

    const tooltip = screen.getByTestId('tooltip-content')
    expect(tooltip.textContent).toContain('Stop dictation')
    expect(tooltip.textContent).toContain('⌘')
    expect(tooltip.textContent).toContain('E')
  })

  it('keeps the shortcut out of the always-visible pill, showing it only on hover', () => {
    const { container } = render(<DictationIndicator />)
    const pill = container.firstChild as HTMLElement

    expect(pill.textContent).toContain('Listening')
    expect(pill.textContent).not.toContain('⌘')
  })

  it('omits the shortcut chip in hold mode, where release stops dictation', () => {
    storeState.settings = { voice: { dictationMode: 'hold' } }
    render(<DictationIndicator />)

    expect(screen.getByRole('button', { name: 'Stop dictation' })).toBeTruthy()
    expect(screen.getByTestId('tooltip-content').textContent).not.toContain('⌘')
  })

  it('hides the stop control once the session is already stopping', () => {
    storeState.dictationState = 'stopping'
    render(<DictationIndicator />)

    expect(screen.getByText('Processing…', { selector: '[aria-hidden="true"]' })).toBeTruthy()
    expect(screen.queryByRole('button', { name: 'Stop dictation' })).toBeNull()
  })

  it('renders nothing while idle', () => {
    storeState.dictationState = 'idle'
    const { container } = render(<DictationIndicator />)

    expect(container.firstChild).toBeNull()
  })

  it('reacts to speaking audio and exposes the semantic state', () => {
    storeState.dictationMeter = {
      level: 0.72,
      isSpeaking: true,
      isClipping: false
    }
    render(<DictationIndicator />)

    expect(screen.getByText('Speaking')).toBeTruthy()
    expect(screen.getByRole('status').textContent).toBe('Listening')
    expect(screen.getByTestId('dictation-grapes').children).toHaveLength(9)
  })

  it('uses the destructive role only while clipping', () => {
    storeState.dictationMeter = {
      level: 1,
      isSpeaking: true,
      isClipping: true
    }
    const { container } = render(<DictationIndicator />)

    expect(screen.getByText('Too loud', { selector: '[aria-hidden="true"]' })).toBeTruthy()
    expect((container.firstChild as HTMLElement).className).toContain('text-destructive')
  })

  it('keeps streaming transcript separate from the listening state', () => {
    storeState.partialTranscript = 'A polished voice visualizer'
    render(<DictationIndicator />)

    expect(screen.getByText('Listening', { selector: '[aria-hidden="true"]' })).toBeTruthy()
    expect(screen.getByText('A polished voice visualizer')).toBeTruthy()
    expect(screen.getByRole('status').textContent).toBe('Listening')
  })
})
