// @vitest-environment happy-dom

import { act, cleanup, render } from '@testing-library/react'
import type { ReactNode } from 'react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { dispatchVoiceControlAction } from './voice-control-events'
import { getVoiceControlUiState, resetVoiceControl } from './voice-control-store'
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

const { useAppStoreMock } = vi.hoisted(() => ({ useAppStoreMock: vi.fn() }))
vi.mock('@/store', () => ({ useAppStore: useAppStoreMock }))

const { createSessionMock, setMutedMock, sessionStopMock, teardownLocalMock } = vi.hoisted(() => ({
  createSessionMock: vi.fn(),
  setMutedMock: vi.fn(),
  sessionStopMock: vi.fn(),
  teardownLocalMock: vi.fn()
}))
// Why: the real session opens a mic and a peer connection; the mute path only needs
// the returned handle. The meter needs an AudioContext happy-dom does not have.
vi.mock('./voice-control-session', () => ({ createVoiceControlSession: createSessionMock }))
vi.mock('./voice-control-level-meter', () => ({
  startVoiceControlMicMeter: () => vi.fn(),
  startVoiceControlOutputMeter: () => vi.fn()
}))

import { VoiceControlController } from './VoiceControlController'

const startMock = vi.fn()
const stopMock = vi.fn()
let stateChangedCallback: ((event: unknown) => void) | null = null

beforeEach(() => {
  startMock.mockReset()
  stopMock.mockReset()
  createSessionMock.mockReset()
  setMutedMock.mockReset()
  sessionStopMock.mockReset()
  teardownLocalMock.mockReset()
  stateChangedCallback = null
  createSessionMock.mockResolvedValue({
    localStream: { getAudioTracks: () => [] },
    setMuted: setMutedMock,
    teardownLocal: teardownLocalMock,
    stop: sessionStopMock
  })
  useAppStoreMock.mockImplementation((selector: (state: unknown) => unknown) =>
    selector({
      settings: undefined,
      keybindings: undefined,
      openSettingsPage: vi.fn(),
      openSettingsTarget: vi.fn(),
      setSettingsSearchQuery: vi.fn()
    })
  )
  // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: stub covers exactly the api surface the controller touches; the full PreloadApi is fixture weight.
  globalThis.window.api = {
    ui: { onVoiceControlToggle: () => vi.fn() },
    voiceControl: {
      start: startMock,
      stop: stopMock,
      getState: vi.fn().mockResolvedValue({ state: 'idle', sessionId: null }),
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

async function startLiveSession(): Promise<void> {
  startMock.mockResolvedValue({ ok: true, sessionId: 's1' })
  render(<VoiceControlController />)
  await act(async () => {
    dispatchVoiceControlAction('start')
  })
  act(() => {
    stateChangedCallback?.({ sessionId: 's1', state: 'live' })
  })
}

describe('VoiceControlController toggle-mute', () => {
  it('mutes and unmutes the live session tracks, mirroring the store', async () => {
    await startLiveSession()

    act(() => {
      dispatchVoiceControlAction('toggle-mute')
    })
    expect(setMutedMock).toHaveBeenCalledWith(true)
    expect(getVoiceControlUiState().micMuted).toBe(true)

    act(() => {
      dispatchVoiceControlAction('toggle-mute')
    })
    expect(setMutedMock).toHaveBeenCalledWith(false)
    expect(getVoiceControlUiState().micMuted).toBe(false)
  })

  it('ignores toggle-mute without a live session', async () => {
    startMock.mockResolvedValue({ ok: true, sessionId: 's1' })
    render(<VoiceControlController />)

    act(() => {
      dispatchVoiceControlAction('toggle-mute')
    })

    expect(setMutedMock).not.toHaveBeenCalled()
    expect(createSessionMock).not.toHaveBeenCalled()
    expect(getVoiceControlUiState().micMuted).toBe(false)
  })

  it('clears the muted flag when main ends the session', async () => {
    await startLiveSession()
    act(() => {
      dispatchVoiceControlAction('toggle-mute')
    })
    expect(getVoiceControlUiState().micMuted).toBe(true)

    act(() => {
      stateChangedCallback?.({ sessionId: null, state: 'idle' })
    })

    expect(getVoiceControlUiState().micMuted).toBe(false)
    expect(teardownLocalMock).toHaveBeenCalled()
  })
})
