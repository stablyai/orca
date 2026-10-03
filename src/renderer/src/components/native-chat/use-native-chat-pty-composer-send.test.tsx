// @vitest-environment happy-dom
import { renderHook } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { AgentType } from '../../../../shared/agent-status-types'
import type { NativeChatSendClassification } from '../../../../shared/native-chat-slash-commands'
import { useNativeChatPtyComposerSend } from './use-native-chat-pty-composer-send'
import { sendNativeChatMessage } from './native-chat-runtime-send'
import { sendNativeChatMessageWithImageAttachments } from './native-chat-runtime-image-send'
import {
  addNativeChatDraftAttachments,
  clearNativeChatDraftAttachments,
  clearNativeChatDraftCacheForTests,
  forgetNativeChatTuiInputSeeds,
  writeNativeChatDraftCache,
  writeNativeChatDraftTuiInputSeed
} from './native-chat-draft-cache'
import { installNativeChatDrafts } from './native-chat-draft-store.test-support'

const handle = vi.hoisted(() => {
  const sendHandle: { cancel: () => void; settleAfterMs: number; settled?: Promise<void> } = {
    cancel: () => {},
    settleAfterMs: 0
  }
  return sendHandle
})
vi.mock('./native-chat-runtime-send', () => ({
  sendNativeChatMessage: vi.fn(() => handle),
  sendNativeChatTypedCommand: vi.fn(() => handle),
  submitNativeChatPrompt: vi.fn()
}))
vi.mock('./native-chat-runtime-image-send', () => ({
  sendNativeChatMessageWithImageAttachments: vi.fn(() => handle)
}))
vi.mock('../../store', () => ({
  // As the store does: dropping the launch draft forgets its input-line seeds.
  useAppStore: { getState: () => ({ clearNativeChatLaunchDraft: forgetNativeChatTuiInputSeeds }) }
}))
vi.mock('@/lib/native-chat-telemetry', () => ({ emitNativeChatMessageSent: vi.fn() }))

const DRAFT_KEY = 'pane:tab:leaf'

function send(
  agent: AgentType,
  classification: NativeChatSendClassification,
  draft: string,
  imagePaths: string[] = [],
  clearImageAttachments: () => void = vi.fn()
) {
  const callbacks = { rejected: vi.fn(), unconfirmed: vi.fn() }
  const { result } = renderHook(() =>
    useNativeChatPtyComposerSend({
      agent,
      draftKey: DRAFT_KEY,
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
      // As the composer's draft hook does: a clear is saved at once.
      setDraft: (value: string) => writeNativeChatDraftCache(DRAFT_KEY, value, 'now'),
      setCaret: vi.fn(),
      clearSkillOrigin: vi.fn(),
      clearImageAttachments,
      setNotice: vi.fn()
    })
  )
  result.current()
  return callbacks
}

let saved: unknown[] = []

beforeEach(() => {
  vi.mocked(sendNativeChatMessage).mockClear()
  vi.mocked(sendNativeChatMessageWithImageAttachments).mockClear()
  saved = []
  installNativeChatDrafts({
    load: async () => [],
    loadSync: () => [],
    write: async (_scopeKey, draft) => {
      saved.push(draft?.text ?? null)
      return 'persisted'
    }
  })
})

afterEach(async () => {
  handle.settled = undefined
  // Lets each send's draft save land in its own test.
  await new Promise((resolve) => setTimeout(resolve, 0))
  clearNativeChatDraftCacheForTests()
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

// A crash before the agent has the message must restore it unsent, and one after must not bring
// it back, so the box's clear is saved only once the terminal write ran.
describe('the saved draft at send', () => {
  function writeRuns(): () => void {
    let finish = () => {}
    handle.settled = new Promise<void>((resolve) => {
      finish = resolve
    })
    return finish
  }

  it('keeps the message saved until the terminal write ran, then saves the empty box', async () => {
    writeNativeChatDraftCache(DRAFT_KEY, 'hello', 'now')
    const finish = writeRuns()

    send('codex', 'chat', 'hello')
    await Promise.resolve()

    expect(sendNativeChatMessage).toHaveBeenCalledOnce()
    expect(saved).toEqual(['hello'])
    finish()
    await vi.waitFor(() => expect(saved).toEqual(['hello', null]))
  })

  it('keeps what was typed after Enter when it saves', async () => {
    writeNativeChatDraftCache(DRAFT_KEY, 'hello', 'now')
    const finish = writeRuns()
    send('codex', 'chat', 'hello')

    writeNativeChatDraftCache(DRAFT_KEY, 'next thought', 'after-pause')
    finish()

    await vi.waitFor(() => expect(saved.at(-1)).toBe('next thought'))
    expect(saved).not.toContain(null)
  })

  it('saves the message typed just before Enter that was still waiting for its pause', async () => {
    writeNativeChatDraftCache(DRAFT_KEY, 'hello', 'after-pause')
    const finish = writeRuns()

    send('codex', 'chat', 'hello')

    expect(saved).toEqual(['hello'])
    finish()
    await vi.waitFor(() => expect(saved).toEqual(['hello', null]))
  })

  it('saves only once the last of several sends in flight has reached the terminal', async () => {
    writeNativeChatDraftCache(DRAFT_KEY, 'first', 'now')
    const finishFirst = writeRuns()
    send('codex', 'chat', 'first')
    writeNativeChatDraftCache(DRAFT_KEY, 'second', 'now')
    const finishSecond = writeRuns()
    send('codex', 'chat', 'second')

    finishFirst()
    await new Promise((resolve) => setTimeout(resolve, 0))
    expect(saved).not.toContain(null)

    finishSecond()
    await vi.waitFor(() => expect(saved.at(-1)).toBeNull())
  })

  // A rejected write delivered nothing, so the message must still be there after a relaunch.
  it('keeps the message saved when the terminal rejected the write', async () => {
    writeNativeChatDraftCache(DRAFT_KEY, 'hello', 'now')
    const finish = writeRuns()
    send('claude', 'chat', 'hello')

    vi.mocked(sendNativeChatMessage).mock.calls[0]?.[3]?.onWriteRejected?.()
    finish()
    await new Promise((resolve) => setTimeout(resolve, 0))

    expect(saved).toEqual(['hello'])
  })

  // The whole clear a real send does: text, image chips, editor and the launch seed.
  it('writes nothing without the message until the terminal write ran, with images and a seed', async () => {
    const writes: { text: string; chips: number; seed: boolean }[] = []
    installNativeChatDrafts({
      load: async () => [],
      loadSync: () => [],
      write: async (_scopeKey, draft) => {
        writes.push({
          text: draft?.text ?? '',
          chips: draft?.attachments.length ?? 0,
          seed: draft?.tuiInputSeed !== undefined
        })
        return 'persisted'
      }
    })
    writeNativeChatDraftTuiInputSeed(DRAFT_KEY, { agent: 'claude', text: 'Fix #12', createdAt: 1 })
    addNativeChatDraftAttachments(DRAFT_KEY, [
      { id: 'shot', path: '/tmp/shot.png', location: 'local' }
    ])
    writeNativeChatDraftCache(DRAFT_KEY, 'look', 'now')
    await new Promise((resolve) => setTimeout(resolve, 0))
    writes.length = 0
    const finish = writeRuns()

    send('claude', 'chat', 'look', ['/tmp/shot.png'], () =>
      clearNativeChatDraftAttachments(DRAFT_KEY)
    )
    await new Promise((resolve) => setTimeout(resolve, 0))

    expect(writes).toEqual([])
    finish()
    await vi.waitFor(() => expect(writes.at(-1)).toEqual({ text: '', chips: 0, seed: false }))
  })
})
