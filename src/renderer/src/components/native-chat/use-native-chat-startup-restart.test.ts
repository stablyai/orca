// @vitest-environment happy-dom

import { renderHook } from '@testing-library/react'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { NativeChatStartupNotice } from '../../../../shared/native-chat-startup-notice'

const mocks = vi.hoisted(() => ({
  queueCodexPaneRestarts: vi.fn(),
  useNativeChatStartupNotice: vi.fn<() => NativeChatStartupNotice | null>()
}))

vi.mock('../../store', () => ({
  useAppStore: { getState: () => ({ queueCodexPaneRestarts: mocks.queueCodexPaneRestarts }) }
}))

// The hook under test now composes useNativeChatStartupNotice internally (folded in to keep
// the call site in NativeChatView.tsx to one hook instead of two — see the file's own
// header comment). Its own poll/latch/phase-detection behavior is covered by
// use-native-chat-startup-notice.test.ts; here it's mocked, driven by the `notice` prop
// each render passes, so these tests stay focused on the restart-authorization decision.
vi.mock('./use-native-chat-startup-notice', () => ({
  useNativeChatStartupNotice: () => mocks.useNativeChatStartupNotice()
}))

import { useNativeChatStartupRestart } from './use-native-chat-startup-restart'

const PTY_ID = 'pty-1'

type Props = { ptyId: string; notice: NativeChatStartupNotice | null }

function updatePromptNotice(options: NativeChatStartupNotice['options']): NativeChatStartupNotice {
  return {
    phase: 'prompt',
    reason: 'codex-update-prompt',
    title: 'Codex has an update',
    body: ['Update available! 0.145.0 -> 0.146.0'],
    options
  }
}

const RESTART_REQUIRED: NativeChatStartupNotice = {
  phase: 'restart-required',
  reason: null,
  title: 'Update complete — restart required',
  body: ['Update ran successfully! Please restart Codex.'],
  options: []
}

const UPDATE_FAILED: NativeChatStartupNotice = {
  phase: 'update-failed',
  reason: null,
  title: 'Codex update did not finish',
  body: ['npm ERR!'],
  options: []
}

describe('useNativeChatStartupRestart', () => {
  let sendRaw: (raw: string) => void
  let onHold: (ptyId: string, holdMs: number) => void

  beforeEach(() => {
    vi.clearAllMocks()
    sendRaw = vi.fn<(raw: string) => void>()
    onHold = vi.fn<(ptyId: string, holdMs: number) => void>()
  })

  function renderRestart(initialProps: Props) {
    return renderHook(
      (props: Props) => {
        mocks.useNativeChatStartupNotice.mockReturnValue(props.notice)
        return useNativeChatStartupRestart({
          paneKey: 'tab-1:leaf-1',
          targetPtyId: props.ptyId,
          readTerminalScreen: () => null,
          isVisible: true,
          messageCount: 0,
          onHoldChatForAgentRestart: onHold,
          sendRaw
        })
      },
      { initialProps }
    )
  }

  it('forwards an unrelated choice without authorizing anything', () => {
    const notice = updatePromptNotice([{ label: 'Trust', send: 't' }])
    const { result } = renderRestart({ ptyId: PTY_ID, notice })
    result.current.onChoose('t')
    expect(sendRaw).toHaveBeenCalledWith('t')
    expect(onHold).not.toHaveBeenCalled()
  })

  it('does not authorize on Skip, so a later restart-required stays manual', () => {
    const notice = updatePromptNotice([
      { label: 'Update now', send: '1' },
      { label: 'Skip', send: '2' }
    ])
    const { result, rerender } = renderRestart({ ptyId: PTY_ID, notice })
    result.current.onChoose('2')
    expect(onHold).not.toHaveBeenCalled()

    rerender({ ptyId: PTY_ID, notice: RESTART_REQUIRED })
    expect(mocks.queueCodexPaneRestarts).not.toHaveBeenCalled()
  })

  it('authorizes on "Update now", then auto-restarts and holds chat once restart-required is observed', () => {
    const notice = updatePromptNotice([
      { label: 'Update now', send: '1' },
      { label: 'Skip', send: '2' }
    ])
    const { result, rerender } = renderRestart({ ptyId: PTY_ID, notice })
    result.current.onChoose('1')
    expect(sendRaw).toHaveBeenCalledWith('1')
    expect(onHold).toHaveBeenCalledWith(PTY_ID, expect.any(Number))

    rerender({ ptyId: PTY_ID, notice: RESTART_REQUIRED })
    expect(mocks.queueCodexPaneRestarts).toHaveBeenCalledWith([PTY_ID])
    expect(result.current.notice).toMatchObject({
      phase: 'restarting',
      body: RESTART_REQUIRED.body
    })
    expect(result.current.onRestart).toBeUndefined()
  })

  it('never authorizes on codex-model-migration-prompt even if a label contains "update"', () => {
    const migrationNotice: NativeChatStartupNotice = {
      phase: 'prompt',
      reason: 'codex-model-migration-prompt',
      title: 'Codex has a new default model',
      body: ['Codex just got an upgrade.'],
      options: [{ label: 'Update to gpt-5.1-codex-max', send: '\r' }]
    }
    const { result, rerender } = renderRestart({ ptyId: PTY_ID, notice: migrationNotice })
    result.current.onChoose('\r')
    expect(onHold).not.toHaveBeenCalled()

    rerender({ ptyId: PTY_ID, notice: RESTART_REQUIRED })
    expect(mocks.queueCodexPaneRestarts).not.toHaveBeenCalled()
    expect(result.current.onRestart).toBeInstanceOf(Function)
  })

  it('offers a manual restart for restart-required with no prior authorization, and queues + holds on click', () => {
    const { result } = renderRestart({ ptyId: PTY_ID, notice: RESTART_REQUIRED })
    expect(result.current.notice).toBe(RESTART_REQUIRED)
    expect(mocks.queueCodexPaneRestarts).not.toHaveBeenCalled()
    result.current.onRestart?.()
    expect(mocks.queueCodexPaneRestarts).toHaveBeenCalledWith([PTY_ID])
    expect(onHold).toHaveBeenCalledWith(PTY_ID, expect.any(Number))
  })

  it('offers a manual restart for update-failed and never auto-restarts it', () => {
    const notice = updatePromptNotice([{ label: 'Update now', send: '1' }])
    const { result, rerender } = renderRestart({ ptyId: PTY_ID, notice })
    result.current.onChoose('1') // authorize
    rerender({ ptyId: PTY_ID, notice: UPDATE_FAILED })
    expect(mocks.queueCodexPaneRestarts).not.toHaveBeenCalled()
    expect(result.current.onRestart).toBeInstanceOf(Function)
  })

  it('does not re-queue a restart already queued for the same pty', () => {
    const { result, rerender } = renderRestart({ ptyId: PTY_ID, notice: RESTART_REQUIRED })
    result.current.onRestart?.()
    result.current.onRestart?.()
    rerender({ ptyId: PTY_ID, notice: RESTART_REQUIRED })
    expect(mocks.queueCodexPaneRestarts).toHaveBeenCalledTimes(1)
  })

  it('drops a stale authorization when the ptyId changes (relaunch/rebind)', () => {
    const notice = updatePromptNotice([{ label: 'Update now', send: '1' }])
    const { result, rerender } = renderRestart({ ptyId: PTY_ID, notice })
    result.current.onChoose('1')
    rerender({ ptyId: 'pty-2', notice: RESTART_REQUIRED })
    expect(mocks.queueCodexPaneRestarts).not.toHaveBeenCalled()
  })
})
