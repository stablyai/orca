// @vitest-environment happy-dom
import { act, renderHook, waitFor } from '@testing-library/react'
import { beforeEach, expect, it, vi } from 'vitest'
import { createMemoryNativeChatComposerDraftStorage } from './native-chat-composer-draft-storage'
import type * as QueuedDraftModule from './native-chat-terminal-queued-drafts'
import { NativeChatTerminalQueuedDrafts } from './native-chat-terminal-queued-drafts'
import { useNativeChatTerminalQueuedMessages } from './use-native-chat-terminal-queued-messages'
import type { NativeChatSendOptions } from './native-chat-input-clear'

let drafts: NativeChatTerminalQueuedDrafts
let refuseWrites: () => void
let mobile = false
let queueEnabled = true
let settleSend: (accepted: boolean) => void
let delayCancellation = false
const sendHandles: { finish: (accepted: boolean) => void; cancel: ReturnType<typeof vi.fn> }[] = []
const writes: { ptyId: string; text: string }[] = []

vi.mock('@/store', () => ({
  useAppStore: (select: (state: unknown) => unknown) =>
    select({ settings: { nativeChatQueueFollowUps: queueEnabled } })
}))
vi.mock('@/lib/pane-manager/mobile-driver-state', () => ({
  getDriverForPty: () => ({ kind: mobile ? 'mobile' : 'desktop' })
}))
vi.mock('sonner', () => ({ toast: { error: vi.fn() } }))
vi.mock('./native-chat-terminal-queued-drafts', async (actual) => ({
  ...(await actual<typeof QueuedDraftModule>()),
  terminalQueuedDrafts: () => drafts
}))
vi.mock('./native-chat-runtime-send', () => ({
  sendNativeChatMessage: (ptyId: string, text: string, options: NativeChatSendOptions) => {
    writes.push({ ptyId, text })
    let resolve: () => void = () => {}
    const settled = new Promise<void>((done) => {
      resolve = done
    })
    const finish = (accepted: boolean) => {
      options.onDeliverySettled?.(accepted)
      resolve()
    }
    settleSend = finish
    const cancel = vi.fn(() => {
      if (!delayCancellation) {
        finish(false)
      }
    })
    sendHandles.push({ finish, cancel })
    return { cancel, settled, settleAfterMs: 0 }
  }
}))

function props() {
  return {
    scope: JSON.stringify(['ssh:builder', 'tab', 'pane', 'codex', 'session']),
    ptyId: 'ssh:builder@@pty-1',
    agent: 'codex' as const,
    working: true,
    completedTurn: 'previous',
    completedAt: 1,
    ready: true,
    canSend: true,
    promptOpen: false,
    onSend: vi.fn(() => 'echo'),
    outcome: { reject: vi.fn(), holdUnconfirmed: vi.fn() }
  }
}

beforeEach(() => {
  const storage = createMemoryNativeChatComposerDraftStorage()
  drafts = new NativeChatTerminalQueuedDrafts(storage)
  refuseWrites = () => {
    storage.refuseWrites = true
  }
  writes.length = 0
  sendHandles.length = 0
  delayCancellation = false
  mobile = false
  queueEnabled = true
})

async function enqueue(
  result: { current: ReturnType<typeof useNativeChatTerminalQueuedMessages> },
  text = 'Follow up'
) {
  await waitFor(async () => {
    let accepted: boolean | null = null
    await act(async () => {
      accepted = await result.current.enqueue(text, [])
    })
    expect(accepted).toBe(true)
  })
}

it('keeps drafts out of the PTY until a confirmed turn ends, then waits for each subsequent turn', async () => {
  const args = props()
  const { result, rerender } = renderHook(useNativeChatTerminalQueuedMessages, {
    initialProps: args
  })
  await enqueue(result, 'First')
  await enqueue(result, 'Second')
  expect(writes).toEqual([])
  rerender({ ...args, working: false })
  expect(writes).toEqual([])
  rerender({ ...args, working: false, completedTurn: 'finished-1', completedAt: 2 })
  await waitFor(() => expect(writes).toEqual([{ ptyId: args.ptyId, text: 'First' }]))
  expect((await drafts.read(args.scope)).messages[0].state).toBe('sending')
  await act(async () => settleSend(true))
  await waitFor(() =>
    expect(result.current.controller.cards.map((card) => card.text)).toEqual(['Second'])
  )
  expect(writes).toHaveLength(1)
  rerender({ ...args, working: false, completedTurn: 'finished-2', completedAt: 3 })
  await waitFor(() => expect(writes.map((write) => write.text)).toEqual(['First', 'Second']))
  await act(async () => settleSend(true))
})

it('holds drafts for questions, mobile ownership, and disconnects', async () => {
  const args = props()
  const { result, rerender } = renderHook(useNativeChatTerminalQueuedMessages, {
    initialProps: args
  })
  await enqueue(result)
  rerender({ ...args, working: false, completedTurn: 'finished', completedAt: 2, promptOpen: true })
  expect(result.current.controller.steerNewest()).toBe(false)
  expect(writes).toEqual([])
  mobile = true
  rerender({ ...args, working: false, completedTurn: 'finished', completedAt: 2 })
  await act(async () => {})
  expect(writes).toEqual([])
  mobile = false
  rerender({ ...args, working: false, completedTurn: 'finished', completedAt: 2, ready: false })
  expect(result.current.controller.steerNewest()).toBe(false)
  expect(writes).toEqual([])
  rerender({ ...args, working: false, completedTurn: 'finished', completedAt: 2 })
  await waitFor(() => expect(writes).toHaveLength(1))
  await act(async () => settleSend(true))
})

it('persists edits and cancellation, and restores only the exact conversation scope', async () => {
  const args = props()
  const { result, unmount } = renderHook(useNativeChatTerminalQueuedMessages, {
    initialProps: args
  })
  await enqueue(result)
  const id = result.current.controller.cards[0].messageId
  await act(async () => result.current.controller.edit(id))
  act(() => result.current.controller.editor?.change('Edited follow up'))
  await act(async () => result.current.controller.editor?.save())
  await waitFor(() => expect(result.current.controller.cards[0].text).toBe('Edited follow up'))
  unmount()
  const other = renderHook(useNativeChatTerminalQueuedMessages, {
    initialProps: { ...args, scope: 'different-host-and-session' }
  })
  expect(other.result.current.controller.cards).toEqual([])
  other.unmount()
  const restored = renderHook(useNativeChatTerminalQueuedMessages, { initialProps: args })
  await waitFor(() =>
    expect(restored.result.current.controller.cards[0]?.text).toBe('Edited follow up')
  )
  await act(async () => restored.result.current.controller.remove(id))
  expect((await drafts.read(args.scope)).messages).toEqual([])
  expect(writes).toEqual([])
})

it('never automatically retries an unknown send after remount', async () => {
  const args = props()
  const first = renderHook(useNativeChatTerminalQueuedMessages, { initialProps: args })
  await enqueue(first.result)
  await act(async () => {
    first.result.current.controller.steerNewest()
  })
  await waitFor(() => expect(writes).toHaveLength(1))
  await act(async () => settleSend(false))
  first.unmount()
  const restored = renderHook(useNativeChatTerminalQueuedMessages, {
    initialProps: { ...args, working: false, completedTurn: 'finished', completedAt: 2 }
  })
  await waitFor(() => expect(restored.result.current.controller.cards[0]?.hold).toBe('unconfirmed'))
  await act(async () => {
    await restored.result.current.controller.resume()
  })
  expect(writes).toHaveLength(1)
  expect(restored.result.current.controller.steerNewest()).toBe(false)
})

it('refuses enqueue when storage cannot commit', async () => {
  const args = props()
  const { result } = renderHook(useNativeChatTerminalQueuedMessages, { initialProps: args })
  await enqueue(result, 'Already saved')
  refuseWrites()
  let accepted: boolean | null = null
  await act(async () => {
    accepted = await result.current.enqueue('Keep in composer', [])
  })
  expect(accepted).toBe(false)
  expect((await drafts.read(args.scope)).messages.map((message) => message.text)).toEqual([
    'Already saved'
  ])
})

it('claims only once when two clients share the same persisted queue', async () => {
  const scope = 'owner-and-session'
  await drafts.change(scope, (queue) => {
    queue.messages.push({ id: 'message', text: 'One send', imagePaths: [], state: 'waiting' })
  })
  const claims = await Promise.all([
    drafts.claim(scope, 'message', true),
    drafts.claim(scope, 'message', true)
  ])
  expect(claims.filter(Boolean)).toHaveLength(1)
  expect((await drafts.read(scope)).messages[0].state).toBe('sending')
})

it('uses the pre-send boundary when completion arrives before transport settlement', async () => {
  const args = props()
  const { result, rerender } = renderHook(useNativeChatTerminalQueuedMessages, {
    initialProps: args
  })
  await enqueue(result, 'First')
  await enqueue(result, 'Second')
  await act(async () => {
    result.current.controller.steerNewest()
  })
  await waitFor(() => expect(writes).toHaveLength(1))
  rerender({ ...args, working: false, completedTurn: 'fast-completion', completedAt: 3 })
  await act(async () => settleSend(true))
  await waitFor(() => expect(writes).toHaveLength(2))
  await act(async () => settleSend(true))
})

it('does not mistake an older window completion for the next turn', async () => {
  const args = props()
  const { result, rerender } = renderHook(useNativeChatTerminalQueuedMessages, {
    initialProps: { ...args, completedAt: 5 }
  })
  await enqueue(result)
  rerender({ ...args, working: false, completedTurn: 'older', completedAt: 2 })
  await act(async () => {})
  expect(writes).toEqual([])
})

it('keeps unsupported TUI steering unavailable while the turn runs', async () => {
  const args = { ...props(), agent: 'claude' as const }
  const { result } = renderHook(useNativeChatTerminalQueuedMessages, { initialProps: args })
  await enqueue(result)
  expect(result.current.controller.cards[0].steerCapable).toBe(false)
  expect(result.current.controller.steerNewest()).toBe(false)
  await act(async () =>
    result.current.controller.steer(result.current.controller.cards[0].messageId)
  )
  expect(writes).toEqual([])
})

it('blocks other dispatchers while editing and recovers abandoned sends only as unknown', async () => {
  const args = props()
  const { result } = renderHook(useNativeChatTerminalQueuedMessages, { initialProps: args })
  await enqueue(result)
  const id = result.current.controller.cards[0].messageId
  await act(async () => result.current.controller.edit(id))
  expect(await drafts.claim(args.scope, id, true)).toBeNull()
  await act(async () => result.current.controller.editor?.cancel())
  const claimed = await drafts.claim(args.scope, id, true)
  expect(claimed?.state).toBe('sending')
  const recovered = await drafts.recover(args.scope, (claimed?.claimedAt ?? 0) + 120_000)
  expect(recovered.messages[0].state).toBe('unknown')
  expect(await drafts.claim(args.scope, id, true)).toBeNull()
})

it('ignores a late settlement after the same draft has a newer claim', async () => {
  const scope = 'host-pane-session'
  await drafts.change(scope, (queue) => {
    queue.messages.push({ id: 'draft', text: 'Example', imagePaths: [], state: 'waiting' })
  })
  const old = await drafts.claim(scope, 'draft', true)
  if (!old) {
    throw new Error('Missing first claim')
  }
  await drafts.recover(scope, (old.claimedAt ?? 0) + 120_000)
  await drafts.change(scope, (queue) => {
    queue.messages[0].state = 'waiting'
    queue.paused = false
  })
  const newer = await drafts.claim(scope, 'draft', true)
  expect(newer?.claimId).not.toBe(old.claimId)
  await drafts.settle(scope, old, true, 'old-turn', 1)
  expect((await drafts.read(scope)).messages[0]).toMatchObject({
    state: 'sending',
    claimId: newer?.claimId
  })
})

it('keeps the composer draft when the initial queue read has not finished', async () => {
  let release: (() => void) | undefined
  const pending = new Promise<void>((resolve) => {
    release = resolve
  })
  const read = drafts.read.bind(drafts)
  vi.spyOn(drafts, 'read').mockImplementation(async (scope) => {
    await pending
    return read(scope)
  })
  const { result } = renderHook(useNativeChatTerminalQueuedMessages, { initialProps: props() })
  expect(await result.current.enqueue('Keep this draft', [])).toBe(false)
  expect(writes).toEqual([])
  await act(async () => release?.())
})

it('keeps a newer send cancellable when an older send settles after leaving and returning', async () => {
  delayCancellation = true
  const args = props()
  const { result, rerender } = renderHook(useNativeChatTerminalQueuedMessages, {
    initialProps: args
  })
  await enqueue(result, 'Old send')
  await act(async () => {
    result.current.controller.steerNewest()
  })
  await waitFor(() => expect(sendHandles).toHaveLength(1))
  rerender({ ...args, scope: 'other-session' })
  expect(sendHandles[0].cancel).toHaveBeenCalledOnce()
  await drafts.recover(args.scope, Date.now() + 120_000)
  await drafts.change(args.scope, (queue) => {
    queue.messages = []
    queue.paused = false
  })
  rerender(args)
  await enqueue(result, 'New send')
  await act(async () => {
    result.current.controller.steerNewest()
  })
  await waitFor(() => expect(sendHandles).toHaveLength(2))
  await act(async () => sendHandles[0].finish(false))
  rerender({ ...args, scope: 'other-session' })
  expect(sendHandles[1].cancel).toHaveBeenCalledOnce()
  await act(async () => sendHandles[1].finish(false))
})

it('cancels a queued send immediately when Stop is pressed', async () => {
  const args = props()
  const { result } = renderHook(useNativeChatTerminalQueuedMessages, { initialProps: args })
  await enqueue(result)
  await act(async () => {
    result.current.controller.steerNewest()
  })
  await waitFor(() => expect(sendHandles).toHaveLength(1))
  await act(async () => result.current.pause())
  expect(sendHandles[0].cancel).toHaveBeenCalledOnce()
  await waitFor(() => expect(result.current.controller.cards[0].hold).toBe('unconfirmed'))
  expect((await drafts.read(args.scope)).paused).toBe(true)
})

it('does not start writing if Stop lands while the persistent claim is awaiting', async () => {
  const args = props()
  const { result } = renderHook(useNativeChatTerminalQueuedMessages, { initialProps: args })
  await enqueue(result)
  const claim = drafts.claim.bind(drafts)
  let release: () => void = () => {}
  const pending = new Promise<void>((resolve) => {
    release = resolve
  })
  vi.spyOn(drafts, 'claim').mockImplementation(async (...args) => {
    const result = await claim(...args)
    await pending
    return result
  })
  await act(async () => {
    result.current.controller.steerNewest()
  })
  await act(async () => result.current.pause())
  await act(async () => release())
  expect(writes).toEqual([])
  expect((await drafts.read(args.scope)).messages[0].state).toBe('waiting')
})

it.each([{ claimedAt: 'invalid' }, { claimedAt: {} }, { claimId: 123 }, { editId: [] }])(
  'rejects malformed persisted queue metadata %j without scheduling recovery',
  async (metadata) => {
    const storage = createMemoryNativeChatComposerDraftStorage()
    drafts = new NativeChatTerminalQueuedDrafts(storage)
    const args = props()
    await storage.write(args.scope, {
      text: JSON.stringify({
        messages: [
          {
            id: 'draft',
            text: 'Saved draft',
            imagePaths: [],
            state: 'sending',
            ...metadata
          }
        ]
      }),
      images: [],
      savedAt: 1
    })
    await expect(drafts.read(args.scope)).rejects.toThrow('Invalid queued draft')
    const recovery = vi.spyOn(drafts, 'recover')
    const { result } = renderHook(useNativeChatTerminalQueuedMessages, { initialProps: args })
    await act(async () => {})
    expect(await result.current.enqueue('Preserve composer', [])).toBe(false)
    expect(recovery).not.toHaveBeenCalled()
  }
)

it.each([false, true])(
  'allows direct sends before queue readiness when disabled=%s',
  async (disabled) => {
    queueEnabled = !disabled
    vi.spyOn(drafts, 'read').mockImplementation(() => new Promise(() => {}))
    const args = { ...props(), working: disabled, ready: false }
    const { result } = renderHook(useNativeChatTerminalQueuedMessages, { initialProps: args })
    expect(result.current.enqueue('Direct send', [])).toBeNull()
  }
)

it('does not carry an empty Stop pause into the next queued turn', async () => {
  const args = props()
  const { result, rerender } = renderHook(useNativeChatTerminalQueuedMessages, {
    initialProps: args
  })
  await act(async () => result.current.pause())
  expect((await drafts.read(args.scope)).paused).toBe(false)
  await enqueue(result)
  rerender({ ...args, working: false, completedTurn: 'finished', completedAt: 2 })
  await waitFor(() => expect(writes).toHaveLength(1))
  await act(async () => settleSend(true))
})

it('releases its edit on unmount and lets the restored queue drain', async () => {
  const args = props()
  const first = renderHook(useNativeChatTerminalQueuedMessages, { initialProps: args })
  await enqueue(first.result)
  const id = first.result.current.controller.cards[0].messageId
  await act(async () => first.result.current.controller.edit(id))
  first.unmount()
  expect((await drafts.read(args.scope)).messages[0].state).toBe('waiting')
  const restored = renderHook(useNativeChatTerminalQueuedMessages, {
    initialProps: { ...args, working: false, completedTurn: 'finished', completedAt: 2 }
  })
  await waitFor(() => expect(writes).toHaveLength(1))
  await act(async () => settleSend(true))
  restored.unmount()
})

it('preserves a newer renderer edit takeover when the old editor unmounts', async () => {
  const args = props()
  const first = renderHook(useNativeChatTerminalQueuedMessages, { initialProps: args })
  await enqueue(first.result)
  const id = first.result.current.controller.cards[0].messageId
  await act(async () => first.result.current.controller.edit(id))
  const oldToken = (await drafts.read(args.scope)).messages[0].editId
  const second = renderHook(useNativeChatTerminalQueuedMessages, { initialProps: args })
  await waitFor(() => expect(second.result.current.controller.cards).toHaveLength(1))
  await act(async () => second.result.current.controller.edit(id))
  const newerToken = (await drafts.read(args.scope)).messages[0].editId
  expect(newerToken).not.toBe(oldToken)
  first.unmount()
  expect((await drafts.read(args.scope)).messages[0]).toMatchObject({
    state: 'editing',
    editId: newerToken
  })
  act(() => second.result.current.controller.editor?.change('Newer edit'))
  await act(async () => second.result.current.controller.editor?.save())
  expect((await drafts.read(args.scope)).messages[0]).toMatchObject({
    state: 'waiting',
    text: 'Newer edit'
  })
  second.unmount()
})

it('releases an edit whose acquisition completes after unmount', async () => {
  const args = props()
  const { result, unmount } = renderHook(useNativeChatTerminalQueuedMessages, {
    initialProps: args
  })
  await enqueue(result)
  const id = result.current.controller.cards[0].messageId
  const change = drafts.change.bind(drafts)
  let release: () => void = () => {}
  const pending = new Promise<void>((resolve) => {
    release = resolve
  })
  vi.spyOn(drafts, 'change').mockImplementationOnce(async (...args) => {
    await pending
    return change(...args)
  })
  let editing: Promise<void> | undefined
  act(() => {
    editing = result.current.controller.edit(id)
  })
  unmount()
  await act(async () => {
    release()
    await editing
  })
  expect((await drafts.read(args.scope)).messages[0].state).toBe('waiting')
})
