// @vitest-environment happy-dom
import { act, renderHook, cleanup } from '@testing-library/react'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import {
  useNativeChatPendingDelivery,
  useNativeChatOptimisticSend,
  NATIVE_CHAT_UNCONFIRMED_SEND_HOLD_MS
} from './use-native-chat-pending-delivery'
import { useNativeChatPtyComposerSend } from './use-native-chat-pty-composer-send'
import { useNativeChatSendLifecycle } from './use-native-chat-send-lifecycle'
import {
  cancelNativeChatPtySends,
  enqueueNativeChatPtySend,
  resetNativeChatPtySendQueuesForTests
} from './native-chat-pty-send-queue'
import { clearPendingSendCacheForTests } from './native-chat-pending'
import type { NativeChatMessage } from '../../../../shared/native-chat-types'
import type { NativeChatComposerHandle } from './native-chat-composer-types'
import type { AgentType } from '../../../../shared/agent-status-types'

const writes = vi.hoisted(() => vi.fn())
const verified = vi.hoisted(() => vi.fn())
vi.mock('@/runtime/runtime-terminal-inspection', () => ({ sendRuntimePtyInput: writes }))
vi.mock('@/runtime/runtime-terminal-verified-input', () => ({
  sendRuntimePtyInputVerified: verified
}))
vi.mock('../../store', () => ({
  useAppStore: { getState: () => ({ clearNativeChatLaunchDraft: () => {} }) }
}))
vi.mock('@/lib/native-chat-telemetry', () => ({ emitNativeChatMessageSent: () => {} }))

beforeEach(() => {
  vi.useFakeTimers()
  clearPendingSendCacheForTests()
  resetNativeChatPtySendQueuesForTests()
  writes.mockClear()
  verified.mockImplementation(() => new Promise(() => {}))
})
afterEach(() => {
  cleanup()
  resetNativeChatPtySendQueuesForTests()
  vi.useRealTimers()
})

it.each(['before-body', 'between-body-enter', 'transport-unknown', 'submitted'] as const)(
  'keeps one full retry owner through %s, global cancel, unmount and a late echo',
  async (phase) => {
    const agent: AgentType = phase === 'transport-unknown' ? 'claude' : 'codex'
    const composerRef: { current: NativeChatComposerHandle | null } = { current: null }
    const boundary: NativeChatMessage = {
      id: 'boundary',
      role: 'assistant',
      blocks: [{ type: 'text', text: 'before' }],
      source: 'transcript',
      timestamp: null
    }
    const render = (messages = [boundary]) =>
      renderHook(() => {
        const pending = useNativeChatPendingDelivery({
          paneKey: 'origin',
          agent,
          session: { messages },
          composerRef
        })
        const onOptimisticSend = useNativeChatOptimisticSend(pending.record, () => {})
        const lifecycle = useNativeChatSendLifecycle('tab', 'pty', pending.cancel, {
          inputOwnedByCard: false,
          onPendingSendRetired: pending.reject
        })
        const send = useNativeChatPtyComposerSend({
          agent,
          draft: 'unrelated draft',
          draftScopeKey: 'origin',
          imageAttachments: [],
          disabled: false,
          isDispatchingSessionOption: false,
          launchDraftResolved: true,
          resolveTarget: () => ({ ptyId: 'pty', settings: null }),
          classifySend: () => 'chat',
          onOptimisticSend,
          optimisticSendOutcome: pending,
          sessionOptionsSurface: null,
          terminalTabId: 'tab',
          trackPendingSend: lifecycle.trackPendingSend,
          setDraft: () => {
            throw new Error('retry changed unrelated draft')
          },
          setCaret: () => {},
          clearSkillOrigin: () => {},
          clearImageAttachments: () => {},
          setNotice: () => {}
        })
        composerRef.current = {
          resend: (text, imagePaths) => send({ text, imagePaths }),
          focus: () => true,
          insertTypedText: () => false,
          acceptsText: () => true,
          appendText: () => {},
          handlePasteEvent: () => {},
          pasteFromClipboard: () => {},
          contains: () => false
        }
        return pending
      })
    let mounted = render()
    act(() =>
      mounted.result.current.reject(mounted.result.current.record('original', ['/original.png']))
    )
    if (phase === 'before-body') {
      enqueueNativeChatPtySend('pty', 5_000, () => {})
    }
    act(() => [...mounted.result.current.notices.values()][0]?.onSend?.())
    if (phase === 'submitted') {
      await act(async () => {
        await vi.advanceTimersByTimeAsync(1_000)
      })
    }
    expect(mounted.result.current.pending).toHaveLength(1)
    mounted.unmount()
    await act(async () => {
      cancelNativeChatPtySends('pty')
      await vi.advanceTimersByTimeAsync(0)
    })
    const writeCount = writes.mock.calls.length
    const verifiedCount = verified.mock.calls.length
    mounted = render()
    expect(mounted.result.current.pending).toMatchObject([
      { text: 'original', imagePaths: ['/original.png'], recovery: true }
    ])
    await act(async () => {
      await vi.advanceTimersByTimeAsync(NATIVE_CHAT_UNCONFIRMED_SEND_HOLD_MS)
    })
    expect(writes.mock.calls.length).toBe(writeCount)
    expect(verified.mock.calls.length).toBe(verifiedCount)
    const delivery = mounted.result.current.pending[0]?.delivery
    expect(delivery).toBe(
      phase === 'before-body' ? 'rejected' : phase === 'submitted' ? undefined : 'unconfirmed'
    )
    expect(mounted.result.current.notices.size).toBe(phase === 'before-body' ? 1 : 0)
    const late: NativeChatMessage = {
      ...boundary,
      id: 'late-receipt',
      role: 'user',
      blocks: [
        { type: 'text', text: 'original' },
        { type: 'image-ref', path: '/original.png' }
      ]
    }
    mounted.unmount()
    mounted = render([boundary, late, { ...boundary, id: 'after-receipt' }])
    expect(mounted.result.current.notices.size).toBe(0)
    expect(mounted.result.current.pending.filter((entry) => entry.delivery)).toEqual([])
  }
)

it('retries admitted skill chat through the notice and real transport without classifying or clearing a newer command draft', async () => {
  const { classifyNativeChatSend } =
    await import('../../../../shared/native-chat/input/native-chat-slash-commands')
  const { answerNativeChatLocalCommand } = await import('./use-native-chat-local-command-answer')
  let origin: string | null = '/context'
  let draft = '/context'
  let images = [{ path: '/original.png' }]
  let disabled = false
  let targetAvailable = true
  const local = vi.fn((command: string, contextWindowTokens: (modelId: string) => number | null) =>
    answerNativeChatLocalCommand({ agent: 'omp', command, messages: [], contextWindowTokens })
  )
  const setDraft = vi.fn((value: string) => {
    draft = value
  })
  const clearOrigin = vi.fn(() => {
    origin = null
  })
  const clearImages = vi.fn(() => {
    images = []
  })
  const composerRef: { current: NativeChatComposerHandle | null } = { current: null }
  const mounted = renderHook(() => {
    const pending = useNativeChatPendingDelivery({
      paneKey: 'skill-origin',
      agent: 'omp',
      session: { messages: [] },
      composerRef
    })
    const optimistic = useNativeChatOptimisticSend(pending.record, () => {})
    const lifecycle = useNativeChatSendLifecycle('tab', 'pty', pending.cancel, {
      inputOwnedByCard: false,
      onPendingSendRetired: pending.reject
    })
    const send = useNativeChatPtyComposerSend({
      agent: 'omp',
      draft,
      draftScopeKey: 'skill-origin',
      imageAttachments: images,
      disabled,
      isDispatchingSessionOption: false,
      launchDraftResolved: true,
      resolveTarget: () => (targetAvailable ? { ptyId: 'pty', settings: null } : null),
      classifySend: (text) => classifyNativeChatSend(text, [{ name: 'context' }], origin, '/'),
      onOptimisticSend: optimistic,
      optimisticSendOutcome: pending,
      answerCommandLocally: local,
      sessionOptionsSurface: null,
      terminalTabId: 'tab',
      trackPendingSend: lifecycle.trackPendingSend,
      setDraft,
      setCaret: () => {},
      clearSkillOrigin: clearOrigin,
      clearImageAttachments: clearImages,
      setNotice: () => {}
    })
    composerRef.current = {
      resend: (text, imagePaths) => send({ text, imagePaths }),
      focus: () => true,
      insertTypedText: () => false,
      acceptsText: () => true,
      appendText: () => {},
      handlePasteEvent: () => {},
      pasteFromClipboard: () => {},
      contains: () => false
    }
    return { pending, send }
  })
  act(() => {
    expect(mounted.result.current.send()).toBe(true)
  })
  expect(local).not.toHaveBeenCalled()
  expect(origin).toBeNull()
  act(() => mounted.result.current.pending.reject(mounted.result.current.pending.pending[0]!.id))
  draft = '/context newer draft'
  images = [{ path: '/newer.png' }]
  origin = '/newer-skill'
  setDraft.mockClear()
  clearOrigin.mockClear()
  clearImages.mockClear()
  disabled = true
  mounted.rerender()
  const oldId = mounted.result.current.pending.pending[0]!.id
  act(() => [...mounted.result.current.pending.notices.values()][0]!.onSend?.())
  expect(mounted.result.current.pending.pending[0]!.id).toBe(oldId)
  disabled = false
  targetAvailable = false
  mounted.rerender()
  act(() => [...mounted.result.current.pending.notices.values()][0]!.onSend?.())
  expect(mounted.result.current.pending.pending[0]!.id).toBe(oldId)
  targetAvailable = true
  mounted.rerender()
  act(() => [...mounted.result.current.pending.notices.values()][0]!.onSend?.())
  expect(mounted.result.current.pending.pending).toMatchObject([
    { text: '/context', imagePaths: ['/original.png'], recovery: true }
  ])
  expect(mounted.result.current.pending.pending[0]!.id).not.toBe(oldId)
  expect(local).not.toHaveBeenCalled()
  expect(setDraft).not.toHaveBeenCalled()
  expect(clearOrigin).not.toHaveBeenCalled()
  expect(clearImages).not.toHaveBeenCalled()
  expect(draft).toBe('/context newer draft')
  expect(origin).toBe('/newer-skill')
  expect(images).toEqual([{ path: '/newer.png' }])
  await act(async () => {
    await vi.advanceTimersByTimeAsync(2000)
  })
  expect(writes.mock.calls.flat().join(' ')).toContain('/context')
  expect(writes.mock.calls.flat().join(' ')).toContain('/original.png')
  expect(writes.mock.calls.flat().join(' ')).not.toContain('newer')
  origin = null
  images = []
  mounted.rerender()
  act(() => {
    expect(mounted.result.current.send()).toBe(false)
  })
  expect(local).toHaveBeenCalledWith('/context newer draft', expect.any(Function))
  expect(setDraft).toHaveBeenCalledWith('')
})
