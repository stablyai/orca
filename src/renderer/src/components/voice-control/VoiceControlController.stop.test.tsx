// @vitest-environment happy-dom

import { act, cleanup, render, screen } from '@testing-library/react'
import type { ReactNode } from 'react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { dispatchVoiceControlAction } from './voice-control-events'
import { resetVoiceControl } from './voice-control-store'
import type * as i18n from '@/i18n/i18n'

// Why: spread the real module — AgentSpeakingChips pulls in agent-catalog, which
// reads the `i18n` export; only translate needs stubbing.
vi.mock('@/i18n/i18n', async (importOriginal) => {
  const actual = await importOriginal<typeof i18n>()
  return { ...actual, translate: (_key: string, fallback: string) => fallback }
})

vi.mock('@/components/ui/tooltip', () => ({
  Tooltip: ({ children }: { children: ReactNode }) => <>{children}</>,
  TooltipTrigger: ({ children }: { children: ReactNode }) => <>{children}</>,
  TooltipContent: ({ children }: { children: ReactNode }) => <>{children}</>
}))

import { VoiceControlController } from './VoiceControlController'

const startMock = vi.fn()
const stopMock = vi.fn()
const getStateMock = vi.fn()
let stateChangedCallback: ((event: unknown) => void) | null = null

beforeEach(() => {
  startMock.mockReset()
  stopMock.mockReset()
  getStateMock.mockReset()
  stateChangedCallback = null
  // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: stub covers exactly the api surface the controller touches; the full PreloadApi is fixture weight.
  globalThis.window.api = {
    ui: { onVoiceControlToggle: () => vi.fn() },
    voiceControl: {
      start: startMock,
      stop: stopMock,
      getState: getStateMock,
      onStateChanged: (callback: (event: unknown) => void) => {
        stateChangedCallback = callback
        return vi.fn()
      },
      onToolActivity: () => vi.fn(),
      onAgentActivity: () => vi.fn(),
      onTranscriptEntry: () => vi.fn(),
      onScreenSnapshotRequest: () => vi.fn(),
      sendScreenSnapshot: vi.fn(),
      onSystemResume: () => vi.fn()
    }
  } as unknown as Window['api']
  act(() => resetVoiceControl())
})

afterEach(() => {
  cleanup()
})

describe('VoiceControlController stop from error', () => {
  it('stops the main-process session the store lost track of after a failed start', async () => {
    startMock.mockResolvedValue({ ok: false, errorKind: 'unknown', error: 'mint blew up' })
    getStateMock.mockResolvedValue({ state: 'error', sessionId: 'sess-parked-in-main' })
    stopMock.mockImplementation(async () => {
      stateChangedCallback?.({ sessionId: null, state: 'idle' })
    })

    render(<VoiceControlController />)
    await act(async () => {
      dispatchVoiceControlAction('start')
    })
    expect(screen.queryByRole('button', { name: 'Talk to your agents' })).toBeNull()

    await act(async () => {
      dispatchVoiceControlAction('stop')
    })

    expect(stopMock).toHaveBeenCalledWith('sess-parked-in-main')
    expect(screen.getByRole('button', { name: 'Talk to your agents' })).toBeTruthy()
  })

  it('resets locally when the failure never created a main session (key-missing)', async () => {
    startMock.mockResolvedValue({
      ok: false,
      errorKind: 'key-missing',
      error: 'OpenAI API key is not configured'
    })
    getStateMock.mockResolvedValue({ state: 'idle', sessionId: null })

    render(<VoiceControlController />)
    await act(async () => {
      dispatchVoiceControlAction('start')
    })
    expect(
      screen.getByText('Add an OpenAI API key in Settings > Voice to use full voice control.')
    ).toBeTruthy()

    await act(async () => {
      dispatchVoiceControlAction('stop')
    })

    expect(stopMock).not.toHaveBeenCalled()
    expect(screen.getByRole('button', { name: 'Talk to your agents' })).toBeTruthy()
  })
})
