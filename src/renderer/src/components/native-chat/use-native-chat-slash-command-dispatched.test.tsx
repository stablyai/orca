// @vitest-environment happy-dom

import { act, renderHook } from '@testing-library/react'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { clearCommandMarkerCacheForTests } from './native-chat-command-marker'
import { useNativeChatSlashCommandDispatched } from './use-native-chat-slash-command-dispatched'

const SCOPE = { paneKey: 'tab-1:leaf-1', agent: 'claude', sessionId: 'session-1' } as const

describe('useNativeChatSlashCommandDispatched', () => {
  const onSwitchToTerminal = vi.fn()
  const setCommandMarkers = vi.fn()

  beforeEach(() => {
    vi.clearAllMocks()
    clearCommandMarkerCacheForTests()
  })

  const render = (agent: 'claude' | 'openclaude' | 'codex') =>
    renderHook(() =>
      useNativeChatSlashCommandDispatched({
        agent,
        commandMarkerScope: { ...SCOPE, agent },
        setCommandMarkers,
        onSwitchToTerminal
      })
    )

  it.each(['claude', 'openclaude', 'codex'] as const)(
    'reveals the terminal when %s dispatches /resume',
    (agent) => {
      // STA-4617: the agent answers it with its own picker, drawn in the TUI the
      // chat view is covering — staying put makes the command look inert.
      const hook = render(agent)
      act(() => hook.result.current('/resume'))

      expect(onSwitchToTerminal).toHaveBeenCalledWith(agent)
    }
  )

  it('holds the reveal until the send settles', async () => {
    // Revealing switches views, which unmounts the chat subtree in the same
    // commit — and the send lifecycle's unmount cleanup cancels every tracked
    // handle, killing the delayed Enter and Ctrl+U-ing the command off the line.
    // A synchronous reveal therefore destroys the send it is revealing.
    let settle = (): void => {}
    const settled = new Promise<void>((resolve) => {
      settle = resolve
    })
    const hook = render('claude')
    act(() => hook.result.current('/resume', settled))

    expect(onSwitchToTerminal).not.toHaveBeenCalled()

    await act(async () => {
      settle()
      await settled
    })
    expect(onSwitchToTerminal).toHaveBeenCalledTimes(1)
  })

  it('still reveals when the send sequence rejects', async () => {
    // A failed write leaves the user stuck in chat otherwise; the terminal is
    // where they can see what actually happened.
    const settled = Promise.reject(new Error('write failed'))
    const hook = render('claude')
    act(() => hook.result.current('/resume', settled))

    await act(async () => {
      await settled.catch(() => undefined)
    })
    expect(onSwitchToTerminal).toHaveBeenCalledTimes(1)
  })

  it('does not reveal after the send was cancelled', async () => {
    const settled = Promise.resolve()
    const cancelled = vi.fn(() => true)
    const hook = render('claude')
    act(() => hook.result.current('/resume', settled, cancelled))

    await act(async () => {
      await settled
    })
    expect(onSwitchToTerminal).not.toHaveBeenCalled()
  })

  it('does not reveal after the originating chat view unmounts', async () => {
    let settle = (): void => {}
    const settled = new Promise<void>((resolve) => {
      settle = resolve
    })
    const hook = render('claude')
    act(() => hook.result.current('/resume', settled))

    hook.unmount()
    settle()
    await settled

    expect(onSwitchToTerminal).not.toHaveBeenCalled()
  })

  it('records the marker immediately, not on settle', async () => {
    // The `Ran /x` line is local feedback for a command with no transcript turn;
    // holding it until the writes finish would lag the user's own action.
    let settle = (): void => {}
    const settled = new Promise<void>((resolve) => {
      settle = resolve
    })
    const hook = render('claude')
    act(() => hook.result.current('/resume', settled))

    expect(setCommandMarkers).toHaveBeenCalledTimes(1)
    await act(async () => {
      settle()
      await settled
    })
  })

  it('leaves the chat view in place for commands the agent answers inline', () => {
    const hook = render('claude')
    act(() => {
      hook.result.current('/clear')
      hook.result.current('/compact')
      hook.result.current('resume the refactor')
    })

    expect(onSwitchToTerminal).not.toHaveBeenCalled()
  })

  it('still records the local marker for a revealing command', () => {
    // The reveal is additive: `/resume` is a control action with no transcript
    // turn, so it needs its `Ran /resume` line exactly like `/clear` does.
    const hook = render('claude')
    act(() => hook.result.current('/resume'))

    expect(setCommandMarkers).toHaveBeenCalledTimes(1)
    expect(setCommandMarkers.mock.calls[0]![0]).toEqual([
      expect.objectContaining({ command: '/resume' })
    ])
  })
})
