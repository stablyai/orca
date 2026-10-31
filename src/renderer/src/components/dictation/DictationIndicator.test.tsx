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

// Portal tooltip content like the real primitive so chip-absence assertions cannot pass through mock containment.
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
})
