// @vitest-environment happy-dom

import { act, cleanup, render } from '@testing-library/react'
import type { ReactNode } from 'react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { VOICE_CONTROL_ACTION_EVENT, type VoiceControlAction } from './voice-control-events'
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

let keybindingCallback: (() => void) | null = null
const startMock = vi.fn()
const stopMock = vi.fn()

beforeEach(() => {
  keybindingCallback = null
  startMock.mockReset()
  stopMock.mockReset()
  // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: stub covers exactly the api surface the controller touches; the full PreloadApi is fixture weight.
  globalThis.window.api = {
    ui: {
      onVoiceControlToggle: (callback: () => void) => {
        keybindingCallback = callback
        return vi.fn()
      }
    },
    voiceControl: {
      start: startMock,
      stop: stopMock,
      onStateChanged: () => vi.fn(),
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

describe('VoiceControlController keybinding', () => {
  it('routes the voice.control keybinding through the control control bus as a toggle', async () => {
    startMock.mockResolvedValue({ ok: false, errorKind: 'unknown', error: 'not configured' })
    const actions: VoiceControlAction[] = []
    const listener = (event: Event): void => {
      if (
        event instanceof CustomEvent &&
        (event.detail === 'start' || event.detail === 'stop' || event.detail === 'toggle')
      ) {
        actions.push(event.detail)
      }
    }
    document.addEventListener(VOICE_CONTROL_ACTION_EVENT, listener)

    render(<VoiceControlController />)
    expect(keybindingCallback).not.toBeNull()

    await act(async () => {
      keybindingCallback?.()
    })

    expect(actions).toEqual(['toggle'])
    // Idle at toggle time, so the bus handler starts a session.
    expect(startMock).toHaveBeenCalledTimes(1)

    document.removeEventListener(VOICE_CONTROL_ACTION_EVENT, listener)
  })
})
