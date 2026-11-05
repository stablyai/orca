// @vitest-environment happy-dom

import { act, cleanup, render } from '@testing-library/react'
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
let stateChangedCallback: ((event: unknown) => void) | null = null

beforeEach(() => {
  startMock.mockReset()
  stopMock.mockReset()
  stateChangedCallback = null
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

describe('VoiceControlController toggle while connecting', () => {
  it('stops a session in awaiting-sdp instead of falling through to a no-op start', async () => {
    render(<VoiceControlController />)
    act(() => {
      stateChangedCallback?.({ sessionId: 's1', state: 'awaiting-sdp' })
    })

    await act(async () => {
      dispatchVoiceControlAction('toggle')
    })

    expect(stopMock).toHaveBeenCalledWith('s1')
    expect(startMock).not.toHaveBeenCalled()
  })

  it('does not re-trigger stop while already stopping', async () => {
    render(<VoiceControlController />)
    act(() => {
      stateChangedCallback?.({ sessionId: 's1', state: 'stopping' })
    })

    await act(async () => {
      dispatchVoiceControlAction('toggle')
    })

    expect(stopMock).not.toHaveBeenCalled()
    expect(startMock).not.toHaveBeenCalled()
  })
})
