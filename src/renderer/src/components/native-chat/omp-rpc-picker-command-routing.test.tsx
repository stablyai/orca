// @vitest-environment happy-dom

import type { Dispatch, SetStateAction } from 'react'

import { act, renderHook, waitFor } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { EMPTY_HISTORY } from './native-chat-composer-state'

const sendNativeChatMessage = vi.fn()
const sendNativeChatTypedCommand = vi.fn()
const runLocalCommand = vi.fn()

vi.mock('./native-chat-runtime-send', () => ({
  sendNativeChatMessage: (...args: unknown[]) => sendNativeChatMessage(...args),
  sendNativeChatTypedCommand: (...args: unknown[]) => sendNativeChatTypedCommand(...args)
}))
vi.mock('@/lib/native-chat-telemetry', () => ({
  emitNativeChatMessageSent: vi.fn(),
  emitNativeChatPickerItemAccepted: vi.fn(),
  emitNativeChatSendClassified: vi.fn()
}))

import { useNativeChatPickerCommandDispatch } from './use-native-chat-picker-command-dispatch'

function commandItem(name: string) {
  return {
    kind: 'command' as const,
    id: `command:${name}`,
    name,
    description: undefined,
    skillCollision: false
  }
}

type OnSlashCommand = NonNullable<
  Parameters<typeof useNativeChatPickerCommandDispatch>[0]['onSlashCommand']
>

function renderDispatch(options: {
  agent: string
  onSlashCommand: OnSlashCommand
  resolveTarget?: () => { settings: Record<string, never>; ptyId: string } | null
  setNotice?: Dispatch<SetStateAction<string | null>>
  sendOmpRpcCommand?: (text: string) => boolean
  clearImageAttachments?: () => void
}) {
  return renderHook(() =>
    useNativeChatPickerCommandDispatch({
      agent: options.agent,
      ompRpcCwd: '/work/a',
      sendOmpRpcCommand: options.sendOmpRpcCommand,
      disabled: false,
      isDispatchingSessionOption: false,
      resolveTarget: options.resolveTarget ?? (() => ({ settings: {}, ptyId: 'pty-1' })),
      onSlashCommand: options.onSlashCommand,
      sessionOptionsSurface: null,
      trackPendingSend: vi.fn(),
      setHistory: vi.fn((update) => update(EMPTY_HISTORY)),
      setDraft: vi.fn(),
      setCaret: vi.fn(),
      setActiveSuggestion: vi.fn(),
      clearSkillOrigin: vi.fn(),
      clearImageAttachments: options.clearImageAttachments ?? vi.fn(),
      setNotice: options.setNotice ?? vi.fn()
    })
  )
}

beforeEach(() => {
  vi.clearAllMocks()
  const handle = { cancel: vi.fn(), settleAfterMs: 0 }
  sendNativeChatMessage.mockReturnValue(handle)
  sendNativeChatTypedCommand.mockReturnValue(handle)
  // Assign onto happy-dom's real window; replacing it wholesale breaks waitFor.
  ;(window as unknown as { api: unknown }).api = { ompRpc: { runLocalCommand } }
})

afterEach(() => {
  delete (window as unknown as { api?: unknown }).api
})

describe('picker dispatch routes OMP /usage over RPC', () => {
  it('sends /usage to the RPC api instead of the PTY, and reports the output', async () => {
    runLocalCommand.mockResolvedValue({
      ok: true,
      outputText: '```\nTokens: 120k\n```',
      agentInvoked: false
    })
    const onSlashCommand = vi.fn()
    const hook = renderDispatch({ agent: 'omp', onSlashCommand })

    act(() => hook.result.current(commandItem('usage')))

    await waitFor(() =>
      expect(onSlashCommand).toHaveBeenCalledWith('/usage', {
        outputText: '```\nTokens: 120k\n```',
        agentInvoked: false
      })
    )
    expect(runLocalCommand).toHaveBeenCalledWith({ cwd: '/work/a', command: '/usage' })
    expect(sendNativeChatMessage).not.toHaveBeenCalled()
    expect(sendNativeChatTypedCommand).not.toHaveBeenCalled()
  })

  it('disarms image attachments on the probe route so none ride the next prompt', async () => {
    runLocalCommand.mockResolvedValue({ ok: true, outputText: '', agentInvoked: false })
    const clearImageAttachments = vi.fn()
    const hook = renderDispatch({ agent: 'omp', onSlashCommand: vi.fn(), clearImageAttachments })

    act(() => hook.result.current(commandItem('usage')))

    expect(clearImageAttachments).toHaveBeenCalledTimes(1)
    await waitFor(() => expect(runLocalCommand).toHaveBeenCalled())
  })

  it('keeps /help on the existing PTY path for the same omp pane', async () => {
    const onSlashCommand = vi.fn()
    const hook = renderDispatch({ agent: 'omp', onSlashCommand })

    act(() => hook.result.current(commandItem('help')))

    expect(sendNativeChatMessage).toHaveBeenCalledWith({}, 'pty-1', '/help')
    expect(runLocalCommand).not.toHaveBeenCalled()
    // No outcome argument: nothing was captured, so nothing is rendered.
    expect(onSlashCommand).toHaveBeenCalledWith('/help')
  })

  it('keeps /usage on the PTY path for a non-omp agent', () => {
    const onSlashCommand = vi.fn()
    const hook = renderDispatch({ agent: 'claude', onSlashCommand })

    act(() => hook.result.current(commandItem('usage')))

    expect(sendNativeChatMessage).toHaveBeenCalledWith({}, 'pty-1', '/usage')
    expect(runLocalCommand).not.toHaveBeenCalled()
  })

  it('falls back to the PTY when the probe is unavailable', async () => {
    runLocalCommand.mockResolvedValue({ ok: false, errorCode: 'executable-not-found' })
    const onSlashCommand = vi.fn()
    const hook = renderDispatch({ agent: 'omp', onSlashCommand })

    act(() => hook.result.current(commandItem('usage')))

    await waitFor(() => expect(sendNativeChatMessage).toHaveBeenCalledWith({}, 'pty-1', '/usage'))
    expect(onSlashCommand).toHaveBeenCalledWith('/usage')
  })
})

describe('picker dispatch on a PTY-less pane (wave 8, D1)', () => {
  it('still sends /usage to the RPC api with no PTY — acquisition succeeding must not disable it', async () => {
    runLocalCommand.mockResolvedValue({
      ok: true,
      outputText: '```\nTokens: 120k\n```',
      agentInvoked: false
    })
    const onSlashCommand = vi.fn()
    const hook = renderDispatch({
      agent: 'omp',
      onSlashCommand,
      resolveTarget: () => null
    })

    act(() => hook.result.current(commandItem('usage')))

    await waitFor(() =>
      expect(onSlashCommand).toHaveBeenCalledWith('/usage', {
        outputText: '```\nTokens: 120k\n```',
        agentInvoked: false
      })
    )
    expect(runLocalCommand).toHaveBeenCalledWith({ cwd: '/work/a', command: '/usage' })
    expect(sendNativeChatMessage).not.toHaveBeenCalled()
    expect(sendNativeChatTypedCommand).not.toHaveBeenCalled()
  })

  it('shows a notice instead of silently dropping a PTY-only command when there is no PTY', () => {
    const onSlashCommand = vi.fn()
    const setNotice = vi.fn()
    const hook = renderDispatch({
      agent: 'claude',
      onSlashCommand,
      resolveTarget: () => null,
      setNotice
    })

    act(() => hook.result.current(commandItem('clear')))

    expect(sendNativeChatMessage).not.toHaveBeenCalled()
    expect(sendNativeChatTypedCommand).not.toHaveBeenCalled()
    expect(onSlashCommand).not.toHaveBeenCalled()
    expect(setNotice).toHaveBeenCalledWith(expect.any(String))
  })
})

describe('picker dispatch routes other catalog commands to the owning session', () => {
  it('sends /help over the RPC session that owns the pane instead of refusing it', () => {
    const sendOmpRpcCommand = vi.fn(() => true)
    const onSlashCommand = vi.fn()
    const setNotice = vi.fn()
    const hook = renderDispatch({
      agent: 'omp',
      onSlashCommand,
      resolveTarget: () => null,
      setNotice,
      sendOmpRpcCommand
    })

    act(() => hook.result.current(commandItem('help')))

    expect(sendOmpRpcCommand).toHaveBeenCalledWith('/help')
    // The marker belongs to the send hook, which records it only once the RPC
    // round trip settles — the picker must not claim it ran up front.
    expect(onSlashCommand).not.toHaveBeenCalled()
    expect(sendNativeChatMessage).not.toHaveBeenCalled()
    expect(sendNativeChatTypedCommand).not.toHaveBeenCalled()
    expect(runLocalCommand).not.toHaveBeenCalled()
    // Nothing was dropped, so the PTY-only notice must not fire.
    expect(setNotice).not.toHaveBeenCalledWith(expect.any(String))
  })

  it('still notices when the session declines the command and there is no PTY', () => {
    const sendOmpRpcCommand = vi.fn(() => false)
    const setNotice = vi.fn()
    const onSlashCommand = vi.fn()
    const hook = renderDispatch({
      agent: 'omp',
      onSlashCommand,
      resolveTarget: () => null,
      setNotice,
      sendOmpRpcCommand
    })

    act(() => hook.result.current(commandItem('help')))

    expect(setNotice).toHaveBeenCalledWith(expect.any(String))
    expect(onSlashCommand).not.toHaveBeenCalled()
  })

  it('prefers a live PTY over the session for a pane RPC does not own', () => {
    const sendOmpRpcCommand = vi.fn(() => false)
    const onSlashCommand = vi.fn()
    const hook = renderDispatch({ agent: 'omp', onSlashCommand, sendOmpRpcCommand })

    act(() => hook.result.current(commandItem('help')))

    expect(sendNativeChatMessage).toHaveBeenCalledWith({}, 'pty-1', '/help')
    expect(onSlashCommand).toHaveBeenCalledWith('/help')
  })

  it('sends /usage over the owning session when that session claims it', () => {
    // The session route only claims a command OMP's published catalog proves it
    // runs; when it does, it beats a probe answering for a different session.
    const sendOmpRpcCommand = vi.fn(() => true)
    const onSlashCommand = vi.fn()
    const hook = renderDispatch({
      agent: 'omp',
      onSlashCommand,
      resolveTarget: () => null,
      sendOmpRpcCommand
    })

    act(() => hook.result.current(commandItem('usage')))

    expect(sendOmpRpcCommand).toHaveBeenCalledWith('/usage')
    expect(runLocalCommand).not.toHaveBeenCalled()
  })

  it('falls back to the session-less probe for /usage when the session declines', async () => {
    runLocalCommand.mockResolvedValue({ ok: true, outputText: 'Usage', agentInvoked: false })
    const sendOmpRpcCommand = vi.fn(() => false)
    const onSlashCommand = vi.fn()
    const hook = renderDispatch({
      agent: 'omp',
      onSlashCommand,
      resolveTarget: () => null,
      sendOmpRpcCommand
    })

    act(() => hook.result.current(commandItem('usage')))

    await waitFor(() =>
      expect(onSlashCommand).toHaveBeenCalledWith('/usage', {
        outputText: 'Usage',
        agentInvoked: false
      })
    )
    expect(runLocalCommand).toHaveBeenCalledWith({ cwd: '/work/a', command: '/usage' })
  })

  it('notices instead of silently dropping /usage when neither the probe nor a PTY answers', async () => {
    // The draft is already claimed and cleared by the time the probe fails, and
    // an acquired pane has no PTY left, so silence would lose the command.
    runLocalCommand.mockResolvedValue({ ok: false, errorCode: 'executable-not-found' })
    const onSlashCommand = vi.fn()
    const setNotice = vi.fn()
    const hook = renderDispatch({
      agent: 'omp',
      onSlashCommand,
      resolveTarget: () => null,
      setNotice,
      sendOmpRpcCommand: vi.fn(() => false)
    })

    act(() => hook.result.current(commandItem('usage')))

    await waitFor(() => expect(setNotice).toHaveBeenCalledWith(expect.any(String)))
    expect(onSlashCommand).not.toHaveBeenCalled()
    expect(sendNativeChatMessage).not.toHaveBeenCalled()
  })
})
