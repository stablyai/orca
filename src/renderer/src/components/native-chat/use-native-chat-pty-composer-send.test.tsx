// @vitest-environment happy-dom

import { act, renderHook } from '@testing-library/react'
import { beforeEach, describe, expect, it, vi } from 'vitest'

const mocks = vi.hoisted(() => ({
  sendNativeChatMessage: vi.fn(),
  sendNativeChatTypedCommand: vi.fn(),
  submitNativeChatPrompt: vi.fn(),
  sendNativeChatMessageWithImageAttachments: vi.fn(),
  resolveComposerSubmitBytes: vi.fn(),
  clearNativeChatLaunchDraft: vi.fn()
}))

vi.mock('../../store', () => ({
  useAppStore: {
    getState: () => ({ clearNativeChatLaunchDraft: mocks.clearNativeChatLaunchDraft })
  }
}))
vi.mock('@/lib/native-chat-telemetry', () => ({ emitNativeChatMessageSent: vi.fn() }))
vi.mock('./native-chat-runtime-send', () => ({
  sendNativeChatMessage: (...a: unknown[]) => mocks.sendNativeChatMessage(...a),
  sendNativeChatTypedCommand: (...a: unknown[]) => mocks.sendNativeChatTypedCommand(...a),
  submitNativeChatPrompt: (...a: unknown[]) => mocks.submitNativeChatPrompt(...a)
}))
vi.mock('./native-chat-runtime-image-send', () => ({
  sendNativeChatMessageWithImageAttachments: (...a: unknown[]) =>
    mocks.sendNativeChatMessageWithImageAttachments(...a)
}))
vi.mock('./native-chat-launch-draft-send', () => ({
  resolveNativeChatLaunchDraftSend: () => ({ sendOptions: undefined })
}))
vi.mock('./native-chat-claude-submit-cache', () => ({
  primeComposerSubmitBytes: vi.fn(),
  resolveComposerSubmitBytes: (...a: unknown[]) => mocks.resolveComposerSubmitBytes(...a)
}))
vi.mock('./native-chat-composer-target', () => ({
  nativeChatComposerTargetIsRemote: () => false
}))
vi.mock('./native-chat-composer-state', () => ({ pushHistory: (previous: unknown) => previous }))
vi.mock('../../../../shared/native-chat-slash-commands', () => ({
  isSlashCommandDraft: () => false
}))

import { useNativeChatPtyComposerSend } from './use-native-chat-pty-composer-send'

type ComposerSendArgs = Parameters<typeof useNativeChatPtyComposerSend>[0]

function composerArgs(overrides: Partial<ComposerSendArgs> = {}): ComposerSendArgs {
  return {
    agent: 'claude',
    draft: 'hello',
    imageAttachments: [],
    disabled: false,
    isDispatchingSessionOption: false,
    launchDraft: null,
    launchDraftResolved: false,
    resolveTarget: () =>
      ({ settings: {}, ptyId: 'pty-1' }) as ReturnType<ComposerSendArgs['resolveTarget']>,
    classifySend: (() => 'chat') as ComposerSendArgs['classifySend'],
    onOptimisticSend: vi.fn(),
    onSlashCommand: vi.fn(),
    sessionOptionsSurface: null,
    terminalTabId: 'tab-1',
    trackPendingSend: vi.fn(),
    setHistory: vi.fn(),
    setDraft: vi.fn(),
    setCaret: vi.fn(),
    clearSkillOrigin: vi.fn(),
    clearImageAttachments: vi.fn(),
    setNotice: vi.fn(),
    ...overrides
  }
}

describe('useNativeChatPtyComposerSend submit gesture wiring', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    mocks.sendNativeChatMessage.mockReturnValue({ cancel: vi.fn() })
    mocks.sendNativeChatMessageWithImageAttachments.mockReturnValue({ cancel: vi.fn() })
  })

  it('carries the resolved submit gesture into an image-attachment send', () => {
    mocks.resolveComposerSubmitBytes.mockReturnValue('\x1b\r')
    const { result } = renderHook(() =>
      useNativeChatPtyComposerSend(composerArgs({ imageAttachments: [{ path: '/tmp/img.png' }] }))
    )
    act(() => result.current())
    expect(mocks.sendNativeChatMessageWithImageAttachments).toHaveBeenCalledWith(
      {},
      'pty-1',
      'hello',
      ['/tmp/img.png'],
      expect.objectContaining({ submitBytes: '\x1b\r' })
    )
  })

  it('carries the resolved submit gesture into a multi-attachment send with every path', () => {
    mocks.resolveComposerSubmitBytes.mockReturnValue('\x1b\r')
    const { result } = renderHook(() =>
      useNativeChatPtyComposerSend(
        composerArgs({ imageAttachments: [{ path: '/tmp/a.png' }, { path: '/tmp/b.png' }] })
      )
    )
    act(() => result.current())
    expect(mocks.sendNativeChatMessageWithImageAttachments).toHaveBeenCalledWith(
      {},
      'pty-1',
      'hello',
      ['/tmp/a.png', '/tmp/b.png'],
      expect.objectContaining({ submitBytes: '\x1b\r' })
    )
  })

  it('carries the resolved submit gesture into a text send', () => {
    mocks.resolveComposerSubmitBytes.mockReturnValue('\x1b\r')
    const { result } = renderHook(() => useNativeChatPtyComposerSend(composerArgs()))
    act(() => result.current())
    expect(mocks.sendNativeChatMessage).toHaveBeenCalledWith(
      {},
      'pty-1',
      'hello',
      expect.objectContaining({ submitBytes: '\x1b\r' })
    )
  })

  it('leaves the send options untouched when no gesture resolves (default CR)', () => {
    mocks.resolveComposerSubmitBytes.mockReturnValue(undefined)
    const { result } = renderHook(() =>
      useNativeChatPtyComposerSend(composerArgs({ imageAttachments: [{ path: '/tmp/img.png' }] }))
    )
    act(() => result.current())
    expect(mocks.sendNativeChatMessageWithImageAttachments).toHaveBeenCalledWith(
      {},
      'pty-1',
      'hello',
      ['/tmp/img.png'],
      undefined
    )
  })
})
