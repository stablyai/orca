// @vitest-environment happy-dom

import { act, renderHook } from '@testing-library/react'
import { beforeEach, describe, expect, it, vi } from 'vitest'

const mocks = vi.hoisted(() => ({
  emitNativeChatMessageSent: vi.fn<(...args: unknown[]) => void>(),
  sendRuntimePtyInput: vi.fn<(...args: unknown[]) => boolean>(() => true),
  nativeChatComposerTargetIsRemote: vi.fn<(...args: unknown[]) => boolean>(() => false),
  pushHistory: vi.fn<(...args: unknown[]) => unknown>((history) => history),
  sendNativeChatMessageVerified: vi.fn<(...args: unknown[]) => unknown>(),
  cancelNativeChatPtySends: vi.fn<(...args: unknown[]) => void>(),
  waitForNativeChatPtyIdle: vi.fn<(...args: unknown[]) => Promise<void>>(() => Promise.resolve()),
  createClaudeModelSwitchConfirmationObserver: vi.fn<(...args: unknown[]) => unknown>(),
  cycleClaudePermissionMode:
    vi.fn<
      (args: {
        target: string
        readMode: () => Promise<string | null>
        sendKey: (key: string) => boolean
        key: string
        isCancelled?: () => boolean
      }) => Promise<unknown>
    >(),
  readNativeChatLiveScreen: vi.fn<(...args: unknown[]) => Promise<string | null>>(() =>
    Promise.resolve(null)
  ),
  readClaudeSessionOptionsFromTerminalScreen: vi.fn<(...args: unknown[]) => unknown>(),
  readClaudePermissionModeFromTerminalScreen: vi.fn<(...args: unknown[]) => string | null>(
    () => null
  ),
  // Records the interleaving of drain vs. write calls so the safety property
  // (drain happens before the opening keystroke) is pinned, not just each call.
  callOrder: [] as string[]
}))

vi.mock('@/lib/native-chat-telemetry', () => ({
  emitNativeChatMessageSent: (...args: unknown[]) => mocks.emitNativeChatMessageSent(...args)
}))

vi.mock('@/runtime/runtime-terminal-inspection', () => ({
  sendRuntimePtyInput: (...args: [unknown, unknown, string]) => {
    mocks.callOrder.push(`send:${args[2]}`)
    return mocks.sendRuntimePtyInput(...args)
  }
}))

vi.mock('./native-chat-composer-target', () => ({
  nativeChatComposerTargetIsRemote: (...args: unknown[]) =>
    mocks.nativeChatComposerTargetIsRemote(...args)
}))

vi.mock('./native-chat-composer-state', () => ({
  pushHistory: (...args: unknown[]) => mocks.pushHistory(...args)
}))

vi.mock('./native-chat-runtime-send', () => ({
  sendNativeChatMessageVerified: (...args: unknown[]) =>
    mocks.sendNativeChatMessageVerified(...args),
  typeNativeChatCommand: (...args: unknown[]) => mocks.sendNativeChatMessageVerified(...args)
}))

vi.mock('./native-chat-pty-send-queue', () => ({
  cancelNativeChatPtySends: (...args: [string]) => {
    mocks.callOrder.push('cancel')
    return mocks.cancelNativeChatPtySends(...args)
  },
  waitForNativeChatPtyIdle: (...args: [string]) => {
    mocks.callOrder.push('idle')
    return mocks.waitForNativeChatPtyIdle(...args)
  }
}))

vi.mock('./claude-model-switch-confirmation', () => ({
  createClaudeModelSwitchConfirmationObserver: (...args: unknown[]) =>
    mocks.createClaudeModelSwitchConfirmationObserver(...args)
}))

vi.mock('./claude-permission-mode-cycle', () => ({
  cycleClaudePermissionMode: (args: Parameters<typeof mocks.cycleClaudePermissionMode>[0]) =>
    mocks.cycleClaudePermissionMode(args)
}))

vi.mock('./native-chat-live-screen', () => ({
  readNativeChatLiveScreen: (...args: unknown[]) => mocks.readNativeChatLiveScreen(...args)
}))

vi.mock('./claude-terminal-session-options', () => ({
  readClaudeSessionOptionsFromTerminalScreen: (...args: unknown[]) =>
    mocks.readClaudeSessionOptionsFromTerminalScreen(...args),
  readClaudePermissionModeFromTerminalScreen: (...args: unknown[]) =>
    mocks.readClaudePermissionModeFromTerminalScreen(...args)
}))

import { useNativeChatSessionOptionCommand } from './use-native-chat-session-option-command'
import type { NativeChatResolvedTarget } from './native-chat-composer-target'
import type { ClaudePermissionModeCycleResult } from './claude-permission-mode-cycle'

const TARGET: NativeChatResolvedTarget = {
  ptyId: 'pty-1',
  settings: { terminalTabId: 'tab-1' } as never
}

describe('useNativeChatSessionOptionCommand — dispatchModeCycle', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    mocks.callOrder.length = 0
    mocks.sendRuntimePtyInput.mockReturnValue(true)
    mocks.readNativeChatLiveScreen.mockResolvedValue(null)
    mocks.cycleClaudePermissionMode.mockResolvedValue({
      outcome: 'applied',
      reason: 'reached',
      presses: 0,
      observed: []
    })
  })

  it('drains the pty send queue before writing the opening keystroke', async () => {
    mocks.cycleClaudePermissionMode.mockImplementation(
      async (args: { key: string; sendKey: (key: string) => boolean }) => {
        // Simulate one press so the write-ordering guarantee is observable.
        return {
          outcome: args.sendKey(args.key) ? 'applied' : 'unknown',
          reason: 'reached',
          presses: 1,
          observed: []
        }
      }
    )
    const { result } = renderHook(() =>
      useNativeChatSessionOptionCommand({
        agent: 'claude',
        disabled: false,
        resolveTarget: () => TARGET,
        setHistory: vi.fn()
      })
    )

    await act(async () => {
      await result.current.dispatchModeCycle({ key: '\x1b[Z', target: 'plan' })
    })

    // The drain must be fully ordered before the ESC[Z write — a delayed chat
    // Enter landing mid-cycle would silently pick a mode for the user.
    expect(mocks.callOrder).toEqual(['cancel', 'idle', 'send:\x1b[Z'])
    expect(mocks.cancelNativeChatPtySends).toHaveBeenCalledWith('pty-1')
    expect(mocks.waitForNativeChatPtyIdle).toHaveBeenCalledWith('pty-1')
  })

  it('invokes the cycler with the key and target, and returns its outcome', async () => {
    mocks.cycleClaudePermissionMode.mockResolvedValue({
      outcome: 'unavailable',
      reason: 'reached',
      presses: 0,
      observed: []
    })
    const { result } = renderHook(() =>
      useNativeChatSessionOptionCommand({
        agent: 'claude',
        disabled: false,
        resolveTarget: () => TARGET,
        setHistory: vi.fn()
      })
    )

    let outcome: ClaudePermissionModeCycleResult | undefined
    await act(async () => {
      outcome = await result.current.dispatchModeCycle({
        key: '\x1b[Z',
        target: 'bypassPermissions'
      })
    })

    expect(mocks.cycleClaudePermissionMode).toHaveBeenCalledWith(
      expect.objectContaining({ target: 'bypassPermissions', key: '\x1b[Z' })
    )
    expect(outcome?.outcome).toBe('unavailable')
  })

  it('reads the current mode through the shared live-screen reader', async () => {
    // The reader owns the fallback, so it drives the injected parser rather than
    // handing a screen back for the caller to parse.
    mocks.readNativeChatLiveScreen.mockImplementation(async (...args: unknown[]) =>
      (args[0] as { parse: (screen: string) => string | null }).parse('some-screen')
    )
    mocks.readClaudePermissionModeFromTerminalScreen.mockReturnValue('plan')
    mocks.cycleClaudePermissionMode.mockImplementation(
      async (args: { readMode: () => Promise<string | null> }) => {
        const mode = await args.readMode()
        return {
          outcome: mode === 'plan' ? 'applied' : 'unknown',
          reason: 'reached',
          presses: 0,
          observed: []
        }
      }
    )
    const { result } = renderHook(() =>
      useNativeChatSessionOptionCommand({
        agent: 'claude',
        disabled: false,
        resolveTarget: () => TARGET,
        setHistory: vi.fn(),
        readTerminalScreen: () => 'fallback-screen'
      })
    )

    let outcome: ClaudePermissionModeCycleResult | undefined
    await act(async () => {
      outcome = await result.current.dispatchModeCycle({ key: '\x1b[Z', target: 'plan' })
    })

    expect(mocks.readNativeChatLiveScreen).toHaveBeenCalledWith(
      expect.objectContaining({ ptyId: 'pty-1' })
    )
    // Reads the status line directly — Claude's banner scrolls away, so the
    // banner-gated scrape cannot be the cycler's source of truth.
    expect(mocks.readClaudePermissionModeFromTerminalScreen).toHaveBeenCalledWith('some-screen')
    expect(outcome?.outcome).toBe('applied')
  })

  it('returns unknown when no live target is available, without throwing', async () => {
    const { result } = renderHook(() =>
      useNativeChatSessionOptionCommand({
        agent: 'claude',
        disabled: false,
        resolveTarget: () => null,
        setHistory: vi.fn()
      })
    )

    let outcome: ClaudePermissionModeCycleResult | undefined
    await act(async () => {
      outcome = await result.current.dispatchModeCycle({ key: '\x1b[Z', target: 'plan' })
    })

    expect(outcome?.outcome).toBe('unknown')
    expect(mocks.cycleClaudePermissionMode).not.toHaveBeenCalled()
    expect(mocks.cancelNativeChatPtySends).not.toHaveBeenCalled()
  })

  it('marks the cycle cancelled once the composer unmounts before it settles', async () => {
    let capturedIsCancelled: (() => boolean) | undefined
    let resolveCycle: ((outcome: ClaudePermissionModeCycleResult) => void) | undefined
    mocks.cycleClaudePermissionMode.mockImplementation((args: { isCancelled?: () => boolean }) => {
      capturedIsCancelled = args.isCancelled
      return new Promise((resolve) => {
        resolveCycle = resolve
      })
    })
    const { result, unmount } = renderHook(() =>
      useNativeChatSessionOptionCommand({
        agent: 'claude',
        disabled: false,
        resolveTarget: () => TARGET,
        setHistory: vi.fn()
      })
    )

    let pending: Promise<ClaudePermissionModeCycleResult> | undefined
    await act(async () => {
      pending = result.current.dispatchModeCycle({ key: '\x1b[Z', target: 'plan' })
      await vi.waitFor(() => expect(capturedIsCancelled).toBeDefined())
    })

    expect(capturedIsCancelled?.()).toBe(false)
    unmount()
    expect(capturedIsCancelled?.()).toBe(true)

    resolveCycle?.({ outcome: 'unknown', reason: 'cancelled', presses: 0, observed: [] })
    await pending
  })
})
