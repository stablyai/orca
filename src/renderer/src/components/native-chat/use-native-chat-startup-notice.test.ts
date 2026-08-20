// @vitest-environment happy-dom

import { act, renderHook } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const storeState = {
  agentStatusByPaneKey: {} as Record<string, { interactivePrompt?: string | null }>
}

vi.mock('../../store', () => ({
  useAppStore: (selector: (state: typeof storeState) => unknown) => selector(storeState)
}))

import { useNativeChatStartupNotice } from './use-native-chat-startup-notice'

const PANE_KEY = 'tab-1:leaf-1'
const PTY_ID = 'pty-1'

const UPDATE_PROMPT_SCREEN = [
  'Update available! 0.145.0 -> 0.146.0',
  '1. Update now',
  '2. Skip',
  'Press enter to continue'
].join('\n')

const RUNNING_SCREEN = [
  'Updating Codex via `npm install -g @openai/codex`...',
  'added 5 packages, and changed 2 packages in 30s'
].join('\n')

const RESTART_REQUIRED_SCREEN = [
  RUNNING_SCREEN,
  '',
  '🎉 Update ran successfully! Please restart Codex.',
  'PS C:\\Users\\visuz\\repo>'
].join('\n')

const READY_SCREEN = [
  ' >_ OpenAI Codex (v0.146.0)',
  ' model:       gpt-5.5 high   /model to change',
  ' directory:   ~/repo'
].join('\n')

function makeScreenReader(initial: string | null): {
  read: () => string | null
  set: (value: string | null) => void
} {
  let current = initial
  return { read: () => current, set: (value) => (current = value) }
}

describe('useNativeChatStartupNotice', () => {
  beforeEach(() => {
    vi.useFakeTimers()
    storeState.agentStatusByPaneKey = {}
  })

  afterEach(() => {
    vi.useRealTimers()
  })

  it('reports null when there is no ptyId or screen reader', () => {
    const { result } = renderHook(() =>
      useNativeChatStartupNotice({
        paneKey: PANE_KEY,
        targetPtyId: null,
        readTerminalScreen: () => null,
        isVisible: true,
        messageCount: 0
      })
    )
    expect(result.current).toBeNull()
  })

  it('detects an update prompt on first tick and keeps polling on the active cadence', () => {
    const screen = makeScreenReader(UPDATE_PROMPT_SCREEN)
    const { result } = renderHook(() =>
      useNativeChatStartupNotice({
        paneKey: PANE_KEY,
        targetPtyId: PTY_ID,
        readTerminalScreen: screen.read,
        isVisible: true,
        messageCount: 0
      })
    )
    expect(result.current?.phase).toBe('prompt')
    expect(result.current?.reason).toBe('codex-update-prompt')
  })

  it('transitions prompt → running → restart-required as the screen changes', () => {
    const screen = makeScreenReader(UPDATE_PROMPT_SCREEN)
    const { result } = renderHook(() =>
      useNativeChatStartupNotice({
        paneKey: PANE_KEY,
        targetPtyId: PTY_ID,
        readTerminalScreen: screen.read,
        isVisible: true,
        messageCount: 0
      })
    )
    expect(result.current?.phase).toBe('prompt')

    screen.set(RUNNING_SCREEN)
    act(() => {
      vi.advanceTimersByTime(300)
    })
    expect(result.current?.phase).toBe('running')

    screen.set(RESTART_REQUIRED_SCREEN)
    act(() => {
      vi.advanceTimersByTime(300)
    })
    expect(result.current?.phase).toBe('restart-required')
  })

  it('settles for good once the agent reaches its ready prompt, and stops polling', () => {
    const screen = makeScreenReader(UPDATE_PROMPT_SCREEN)
    const { result } = renderHook(() =>
      useNativeChatStartupNotice({
        paneKey: PANE_KEY,
        targetPtyId: PTY_ID,
        readTerminalScreen: screen.read,
        isVisible: true,
        messageCount: 0
      })
    )
    screen.set(READY_SCREEN)
    act(() => {
      vi.advanceTimersByTime(300)
    })
    expect(result.current).toBeNull()

    // Even if the screen flips back to a dialog, the latch for this ptyId must not reopen.
    screen.set(UPDATE_PROMPT_SCREEN)
    act(() => {
      vi.advanceTimersByTime(10_000)
    })
    expect(result.current).toBeNull()
  })

  it('resets the settled latch when the ptyId changes (relaunch)', () => {
    const screen = makeScreenReader(READY_SCREEN)
    const { result, rerender } = renderHook(
      (props: { ptyId: string }) =>
        useNativeChatStartupNotice({
          paneKey: PANE_KEY,
          targetPtyId: props.ptyId,
          readTerminalScreen: screen.read,
          isVisible: true,
          messageCount: 0
        }),
      { initialProps: { ptyId: PTY_ID } }
    )
    act(() => {
      vi.advanceTimersByTime(300)
    })
    expect(result.current).toBeNull()

    screen.set(UPDATE_PROMPT_SCREEN)
    rerender({ ptyId: 'pty-2' })
    expect(result.current?.phase).toBe('prompt')
  })

  it('suppresses the notice when a hook-reported interactive prompt is present', () => {
    storeState.agentStatusByPaneKey[PANE_KEY] = { interactivePrompt: '{"questions":[]}' }
    const screen = makeScreenReader(UPDATE_PROMPT_SCREEN)
    const { result } = renderHook(() =>
      useNativeChatStartupNotice({
        paneKey: PANE_KEY,
        targetPtyId: PTY_ID,
        readTerminalScreen: screen.read,
        isVisible: true,
        messageCount: 0
      })
    )
    expect(result.current).toBeNull()
  })

  it('stops watching once a real transcript message arrives after mount', () => {
    const screen = makeScreenReader(UPDATE_PROMPT_SCREEN)
    const { result, rerender } = renderHook(
      (props: { messageCount: number }) =>
        useNativeChatStartupNotice({
          paneKey: PANE_KEY,
          targetPtyId: PTY_ID,
          readTerminalScreen: screen.read,
          isVisible: true,
          messageCount: props.messageCount
        }),
      { initialProps: { messageCount: 3 } } // resumed session, messages already present
    )
    expect(result.current?.phase).toBe('prompt')

    rerender({ messageCount: 4 }) // a NEW message arrived — proof of life
    expect(result.current).toBeNull()

    // Must stay settled even if the screen still looks like a dialog.
    act(() => {
      vi.advanceTimersByTime(10_000)
    })
    expect(result.current).toBeNull()
  })

  it('does not poll while the pane is not visible', () => {
    const screen = makeScreenReader(UPDATE_PROMPT_SCREEN)
    const { result } = renderHook(() =>
      useNativeChatStartupNotice({
        paneKey: PANE_KEY,
        targetPtyId: PTY_ID,
        readTerminalScreen: screen.read,
        isVisible: false,
        messageCount: 0
      })
    )
    expect(result.current).toBeNull()
  })

  it('gives up after the watch budget expires without ever reaching a ready prompt', () => {
    // Simulates a resumed session whose Codex header already scrolled out of the viewport —
    // the screen never matches a known-ready pattern, so the watch must give up on its own.
    const screen = makeScreenReader('some unrelated shell output\n')
    const { result } = renderHook(() =>
      useNativeChatStartupNotice({
        paneKey: PANE_KEY,
        targetPtyId: PTY_ID,
        readTerminalScreen: screen.read,
        isVisible: true,
        messageCount: 0
      })
    )
    expect(result.current).toBeNull()
    act(() => {
      vi.advanceTimersByTime(120_001)
    })
    expect(result.current).toBeNull()

    // Confirm the watch actually stopped (latched settled) rather than merely reporting null
    // this tick: a dialog appearing afterward must not reopen it.
    screen.set(UPDATE_PROMPT_SCREEN)
    act(() => {
      vi.advanceTimersByTime(10_000)
    })
    expect(result.current).toBeNull()
  })
})
