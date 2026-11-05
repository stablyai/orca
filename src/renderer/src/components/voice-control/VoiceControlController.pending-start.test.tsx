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

const { createSessionMock, sessionStopMock, teardownLocalMock, micMeterMock } = vi.hoisted(() => ({
  createSessionMock: vi.fn(),
  sessionStopMock: vi.fn(),
  teardownLocalMock: vi.fn(),
  micMeterMock: vi.fn()
}))
// Why: the real session opens a mic and a peer connection; these tests only need the
// returned handle. The meter needs an AudioContext happy-dom does not have.
vi.mock('./voice-control-session', () => ({ createVoiceControlSession: createSessionMock }))
vi.mock('./voice-control-level-meter', () => ({
  startVoiceControlMicMeter: micMeterMock,
  startVoiceControlOutputMeter: () => vi.fn()
}))

import { VoiceControlController } from './VoiceControlController'

const startMock = vi.fn()
const stopMock = vi.fn()
let stateChangedCallback: ((event: unknown) => void) | null = null
let resolveSession: ((session: unknown) => void) | null = null

beforeEach(() => {
  startMock.mockReset()
  stopMock.mockReset()
  createSessionMock.mockReset()
  sessionStopMock.mockReset()
  teardownLocalMock.mockReset()
  micMeterMock.mockReset()
  stateChangedCallback = null
  resolveSession = null
  startMock.mockResolvedValue({ ok: true, sessionId: 's1' })
  // Session setup stays pending until the test resolves it — the VAD-model load window.
  createSessionMock.mockImplementation(
    () =>
      new Promise((resolve) => {
        resolveSession = resolve
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

function resolvePendingSession(): void {
  resolveSession?.({
    localStream: { getAudioTracks: () => [] },
    setMuted: vi.fn(),
    teardownLocal: teardownLocalMock,
    stop: sessionStopMock
  })
}

describe('VoiceControlController pending start teardown', () => {
  it.each([
    { event: { sessionId: 's1', state: 'error', errorKind: 'unavailable' }, label: 'error' },
    { event: { sessionId: null, state: 'idle', endReason: 'idle-suspend' }, label: 'idle' }
  ])(
    'stops a session that resolves after main published $label mid-setup',
    async ({ event, label }) => {
      render(<VoiceControlController />)
      await act(async () => {
        dispatchVoiceControlAction('start')
      })
      expect(createSessionMock).toHaveBeenCalledTimes(1)

      act(() => {
        stateChangedCallback?.(event)
      })
      expect(getVoiceControlUiState().state).toBe(label)

      await act(async () => {
        resolvePendingSession()
      })

      // The late session hits the run-id guard and stops — no live mic, no meter, and
      // the store keeps the state main published.
      expect(sessionStopMock).toHaveBeenCalledTimes(1)
      expect(micMeterMock).not.toHaveBeenCalled()
      expect(getVoiceControlUiState().state).toBe(label)
    }
  )
})
