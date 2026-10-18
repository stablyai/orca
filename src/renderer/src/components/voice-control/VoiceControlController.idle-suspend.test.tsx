// @vitest-environment happy-dom

import { act, cleanup, render } from '@testing-library/react'
import type { ReactNode } from 'react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { resetVoiceControl } from './voice-control-store'
import type * as i18n from '@/i18n/i18n'
import type * as sonner from 'sonner'

// Why: spread the real module — AgentSpeakingChips pulls in agent-catalog, which
// reads the `i18n` export; only translate needs stubbing.
vi.mock('@/i18n/i18n', async (importOriginal) => {
  const actual = await importOriginal<typeof i18n>()
  return { ...actual, translate: (_key: string, fallback: string) => fallback }
})

const { toastMessageMock } = vi.hoisted(() => ({ toastMessageMock: vi.fn() }))
vi.mock('sonner', async (importOriginal) => {
  const actual = await importOriginal<typeof sonner>()
  return { ...actual, toast: { ...actual.toast, message: toastMessageMock } }
})

vi.mock('@/components/ui/tooltip', () => ({
  Tooltip: ({ children }: { children: ReactNode }) => <>{children}</>,
  TooltipTrigger: ({ children }: { children: ReactNode }) => <>{children}</>,
  TooltipContent: ({ children }: { children: ReactNode }) => <>{children}</>
}))

import { VoiceControlController } from './VoiceControlController'

let stateChangedCallback: ((event: unknown) => void) | null = null

beforeEach(() => {
  toastMessageMock.mockReset()
  stateChangedCallback = null
  // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: stub covers exactly the api surface the controller touches; the full PreloadApi is fixture weight.
  globalThis.window.api = {
    ui: { onVoiceControlToggle: () => vi.fn() },
    voiceControl: {
      start: vi.fn(),
      stop: vi.fn(),
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

describe('VoiceControlController idle suspend', () => {
  it('toasts when main ends the session for quiet', () => {
    render(<VoiceControlController />)

    act(() => {
      stateChangedCallback?.({ sessionId: null, state: 'idle', endReason: 'idle-suspend' })
    })

    expect(toastMessageMock).toHaveBeenCalledWith('Voice control paused after a few quiet minutes.')
  })

  it('stays quiet for ordinary stops and other end reasons', () => {
    render(<VoiceControlController />)

    act(() => {
      stateChangedCallback?.({ sessionId: null, state: 'idle' })
      stateChangedCallback?.({ sessionId: null, state: 'idle', endReason: 'max-session-minutes' })
      stateChangedCallback?.({ sessionId: null, state: 'error', errorKind: 'ice-failed' })
    })

    expect(toastMessageMock).not.toHaveBeenCalled()
  })
})
