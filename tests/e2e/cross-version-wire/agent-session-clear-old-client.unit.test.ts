// @vitest-environment happy-dom
import { act, cleanup, renderHook } from '@testing-library/react'
import { afterEach, expect, test, vi } from 'vitest'
import { importReleaseCheckoutModule, materializeReleaseCheckout } from './release-checkout'
import {
  createQueuedMessageTestRig,
  eventually,
  QUEUED_RIG_CALLER as CALLER
} from '../../../src/main/native-chat/agent-session-wire/structured-agent-session-queued-message-rig.test-fixture'
import {
  HOST_TEST_SESSION as SESSION,
  hostTestOperationId
} from '../../../src/main/native-chat/agent-session-wire/structured-agent-session-host-test-data'
import { agentJournalSubmissionKey } from '../../../src/shared/agent-session-journal-item-key'
import { EMPTY_STRUCTURED_AGENT_SESSION } from '../../../src/shared/structured-agent-session-reducer'
import type { useNativeChatRewind } from '../../../src/renderer/src/components/native-chat/use-native-chat-rewind'

const toastError = vi.hoisted(() => vi.fn())
vi.mock('sonner', () => ({ toast: { error: toastError } }))

type RewindInput = Parameters<typeof useNativeChatRewind>[0]
type OldRewindModule = Record<string, unknown> & {
  useNativeChatRewind: typeof useNativeChatRewind
}
function isOldRewindModule(module: Record<string, unknown>): module is OldRewindModule {
  return typeof module.useNativeChatRewind === 'function'
}

afterEach(() => {
  cleanup()
  vi.useRealTimers()
  toastError.mockReset()
})

test('an older desktop releases its clear hold from the actual same-conversation result while its pane stays mounted', async () => {
  const checkout = await materializeReleaseCheckout('b6b4d68cd844c921c7c5191cef72d5adafc0dafa')
  const [commands, pending] = await Promise.all([
    importReleaseCheckoutModule(
      checkout,
      'src/renderer/src/components/native-chat/use-structured-agent-session-command-write.ts'
    ),
    importReleaseCheckoutModule(
      checkout,
      'src/renderer/src/components/native-chat/structured-agent-session-pending-sends.ts'
    )
  ])
  const useCommand = commands.useStructuredAgentSessionCommandWrite
  const held = pending.structuredAgentSessionSendsHeld
  if (typeof useCommand !== 'function' || typeof held !== 'function') {
    throw new Error('historical clear hold missing')
  }
  const rig = await createQueuedMessageTestRig({ restartable: true })
  try {
    const before = await rig.host.journalSnapshot(SESSION)
    const view = renderHook(() =>
      useCommand(SESSION, async () => {
        const fields = { command: 'clear' as const }
        const result = await rig.host.conversationCommand(CALLER, {
          ...fields,
          envelope: rig.envelope(fields, 'agentSession.conversationCommand', hostTestOperationId())
        })
        if (!result.ok) {
          throw new Error('clear failed')
        }
        expect(result.value.replacementSessionId).toBeUndefined()
        return { kind: 'done', value: result.value }
      })
    )
    let request: Promise<unknown> | undefined
    act(() => {
      request = view.result.current('clear')
    })
    expect(held(SESSION)).toBe(true)
    await act(async () => {
      expect(await request).toMatchObject({
        kind: 'done',
        value: { command: 'clear', state: 'completed' }
      })
    })
    expect(held(SESSION)).toBe(false)
    const after = await rig.host.journalSnapshot(SESSION)
    expect(after.cursor.epoch).toBe(before.cursor.epoch)
    expect(after.items.slice(0, before.items.length)).toEqual(before.items)
    expect(after.items.at(-1)?.body).toMatchObject({ presentation: 'context-cleared' })
  } finally {
    cleanup()
    await rig.dispose()
  }
}, 300_000)

test('an older rewind-capable desktop releases its temporary same-epoch hold without losing history or its returned draft', async () => {
  const checkout = await materializeReleaseCheckout('b6b4d68cd844c921c7c5191cef72d5adafc0dafa')
  vi.doMock(
    `${checkout.root}/src/renderer/src/runtime/structured-agent-session-host-capability.ts`,
    () => ({
      useStructuredAgentSessionHostRecoversRewindOnSend: () => true
    })
  )
  const [module, drafts] = await Promise.all([
    importReleaseCheckoutModule(
      checkout,
      'src/renderer/src/components/native-chat/use-native-chat-rewind.ts'
    ),
    importReleaseCheckoutModule(
      checkout,
      'src/renderer/src/components/native-chat/native-chat-draft-cache.ts'
    )
  ])
  if (!isOldRewindModule(module) || typeof drafts.readNativeChatDraftCache !== 'function') {
    throw new Error('historical rewind hook or draft reader missing')
  }
  const rig = await createQueuedMessageTestRig({
    restartable: true,
    rewind: async () => ({ ok: true })
  })
  try {
    async function send(text: string, turn: string) {
      const sent = rig.send(text)
      expect(await sent.result).toMatchObject({ ok: true })
      await eventually(async () =>
        expect((await rig.submission(sent.id))?.handedOverAt).toBeDefined()
      )
      await rig.settleAccepted(sent.id, turn)
      return agentJournalSubmissionKey(sent.id)
    }
    await send('earlier context remains visible', 'old')
    const clear = { command: 'clear' as const }
    expect(
      await rig.host.conversationCommand(CALLER, {
        ...clear,
        envelope: rig.envelope(clear, 'agentSession.conversationCommand', hostTestOperationId())
      })
    ).toMatchObject({ ok: true })
    await send('keep this current-context message', 'kept')
    const target = await send('return this message to the draft', 'target')
    const before = await rig.host.journalSnapshot(SESSION)
    const fields = { itemId: target, expectedEpoch: before.cursor.epoch }
    const result = await rig.host.rewind(CALLER, {
      ...fields,
      envelope: rig.envelope(fields, 'agentSession.rewind', hostTestOperationId())
    })
    expect(result).toMatchObject({ ok: true })
    if (!result.ok) {
      throw new Error('suffix rewind failed')
    }
    const after = await rig.host.journalSnapshot(SESSION)
    expect(after.cursor.epoch).toBe(before.cursor.epoch)
    expect(result.value.sequence).toBe(after.cursor.sequence)
    expect(after.items.map((item) => item.body)).toEqual(
      before.items.filter((item) => item.itemId !== target).map((item) => item.body)
    )
    const floor = rig.host.collaboratorsForTests().sessions.get(SESSION)!.journal.context.floor()!
    expect(after.items.filter((item) => item.sequence <= floor.sequence)).toEqual(
      before.items.filter((item) => item.sequence <= floor.sequence)
    )

    vi.useFakeTimers()
    const input: RewindInput = {
      sessionId: SESSION,
      composerScopeKey: 'old-rewind-clear-compat',
      state: {
        ...EMPTY_STRUCTURED_AGENT_SESSION,
        status: 'ready',
        epoch: before.cursor.epoch,
        cursor: before.cursor,
        fence: result.fence,
        items: before.items,
        submissions: before.submissions
      },
      support: { supported: true },
      blocked: false,
      send: async () => ({ kind: 'done', value: result.value })
    }
    const view = renderHook((props: RewindInput) => module.useNativeChatRewind(props), {
      initialProps: input
    })
    await act(() => view.result.current.request(target, async () => true))
    view.rerender({ ...input, state: { ...input.state, cursor: after.cursor, items: after.items } })
    expect(view.result.current.pending).toBe(true)
    expect(view.result.current.blockedRef.current).toBe(true)
    expect(drafts.readNativeChatDraftCache(input.composerScopeKey)).toContain(
      'return this message to the draft'
    )
    act(() => vi.advanceTimersByTime(119_999))
    expect(view.result.current.blockedRef.current).toBe(true)
    act(() => vi.advanceTimersByTime(1))
    expect(view.result.current.pending).toBe(false)
    expect(view.result.current.blockedRef.current).toBe(false)
    expect(toastError).toHaveBeenCalledOnce()
    expect(await rig.host.journalSnapshot(SESSION)).toEqual(after)
  } finally {
    cleanup()
    vi.useRealTimers()
    await rig.dispose()
  }
}, 300_000)
