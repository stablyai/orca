// @vitest-environment happy-dom
import { renderHook } from '@testing-library/react'
import { beforeEach, expect, it, vi } from 'vitest'
import type { AgentType } from '../../../../shared/agent-status-types'
import type { NativeChatSendClassification } from '../../../../shared/native-chat-slash-commands'
import { useNativeChatPtyComposerSend } from './use-native-chat-pty-composer-send'
import { sendNativeChatMessage, sendNativeChatTypedCommand } from './native-chat-runtime-send'
import { sendNativeChatMessageWithImageAttachments } from './native-chat-runtime-image-send'

const handle = vi.hoisted(() => ({ cancel: () => {}, settleAfterMs: 0 }))
vi.mock('./native-chat-runtime-send', () => ({
  sendNativeChatMessage: vi.fn(() => handle),
  sendNativeChatTypedCommand: vi.fn(() => handle),
  submitNativeChatPrompt: vi.fn()
}))
vi.mock('./native-chat-runtime-image-send', () => ({
  sendNativeChatMessageWithImageAttachments: vi.fn(() => handle)
}))
vi.mock('../../store', () => ({
  useAppStore: { getState: () => ({ clearNativeChatLaunchDraft: vi.fn(), tabsByWorktree: {} }) }
}))
vi.mock('@/lib/native-chat-telemetry', () => ({ emitNativeChatMessageSent: vi.fn() }))

function send(
  agent: AgentType,
  classification: NativeChatSendClassification,
  draft: string,
  imagePaths: string[] = []
) {
  const callbacks = { rejected: vi.fn(), unconfirmed: vi.fn(), notice: vi.fn(), setDraft: vi.fn() }
  const { result } = renderHook(() =>
    useNativeChatPtyComposerSend({
      agent,
      draft,
      imageAttachments: imagePaths.map((path) => ({ path })),
      disabled: false,
      isDispatchingSessionOption: false,
      launchDraftResolved: true,
      resolveTarget: () => ({ ptyId: 'pty', settings: null }),
      classifySend: () => classification,
      onOptimisticSend: () => 'pending-1',
      optimisticSendOutcome: { reject: callbacks.rejected, holdUnconfirmed: callbacks.unconfirmed },
      sessionOptionsSurface: null,
      terminalTabId: 'tab',
      trackPendingSend: vi.fn(),
      setHistory: vi.fn(),
      setDraft: callbacks.setDraft,
      setCaret: vi.fn(),
      clearSkillOrigin: vi.fn(),
      clearImageAttachments: vi.fn(),
      setNotice: callbacks.notice
    })
  )
  result.current()
  return callbacks
}

beforeEach(() => {
  vi.mocked(sendNativeChatMessage).mockClear()
  vi.mocked(sendNativeChatTypedCommand).mockClear()
  vi.mocked(sendNativeChatMessageWithImageAttachments).mockClear()
})

it('routes a Claude chat send outcome to its own pending echo', () => {
  const callbacks = send('claude', 'chat', 'hello')
  const options = vi.mocked(sendNativeChatMessage).mock.calls[0]?.[3]
  options?.onWriteRejected?.()
  options?.onWriteUnconfirmed?.()
  expect(callbacks.rejected).toHaveBeenCalledWith('pending-1')
  expect(callbacks.unconfirmed).toHaveBeenCalledWith('pending-1')
})

it('routes a Claude image send outcome to its own pending echo', () => {
  const callbacks = send('claude', 'chat', 'look', ['/tmp/shot.png'])
  vi.mocked(sendNativeChatMessageWithImageAttachments).mock.calls[0]?.[5]?.onWriteRejected?.()
  expect(callbacks.rejected).toHaveBeenCalledWith('pending-1')
})

it.each([
  ['codex', 'chat', 'hello'],
  ['claude', 'command', '/compact']
] as const)('leaves a %s %s send on the unobserved write path', (agent, classification, draft) => {
  send(agent, classification, draft)
  expect(vi.mocked(sendNativeChatMessage).mock.calls[0]?.[3]?.onWriteRejected).toBeUndefined()
})

it.each(['codex', 'claude'] as const)(
  "shows a %s message the host refused as 'Message not sent' on its own row (F2)",
  (agent) => {
    const callbacks = send(agent, 'chat', 'hello')
    const options = vi.mocked(sendNativeChatMessage).mock.calls[0]?.[3]
    options?.chatAction?.onRefused?.({ nothingWritten: true })
    expect(callbacks.rejected).toHaveBeenCalledWith('pending-1')
    expect(callbacks.notice).not.toHaveBeenCalledWith('Message not sent')
  }
)

it('tags every write of an image send with one action and rejects its row on refusal (F2)', () => {
  const callbacks = send('codex', 'chat', 'look', ['/tmp/shot.png'])
  const options = vi.mocked(sendNativeChatMessageWithImageAttachments).mock.calls[0]?.[5]
  expect(options?.chatAction?.actionId).toMatch(/^chat-/)
  options?.chatAction?.onRefused?.({ nothingWritten: true })
  expect(callbacks.rejected).toHaveBeenCalledWith('pending-1')
})

it("names a refused typed command on the composer's notice line, since it has no row (F2)", () => {
  const callbacks = send('codex', 'command', '/compact')
  const action = vi.mocked(sendNativeChatTypedCommand).mock.calls[0]?.[3]
  expect(action?.actionId).toMatch(/^chat-/)
  action?.onRefused?.({ nothingWritten: true })
  expect(callbacks.notice).toHaveBeenLastCalledWith('Message not sent')
  expect(callbacks.rejected).not.toHaveBeenCalled()
  // R1B-N5: nothing reached the PTY, so the unsent command returns to the composer.
  expect(callbacks.setDraft).toHaveBeenLastCalledWith('/compact')
})

it('does not offer a partly typed command again as if nothing was sent', () => {
  const callbacks = send('codex', 'command', '/compact')
  const action = vi.mocked(sendNativeChatTypedCommand).mock.calls[0]?.[3]
  action?.onRefused?.({ nothingWritten: false })
  expect(callbacks.notice).toHaveBeenLastCalledWith('Message not sent')
  expect(callbacks.setDraft).toHaveBeenLastCalledWith('')
})
