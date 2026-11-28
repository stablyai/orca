// @vitest-environment happy-dom
import { act, render } from '@testing-library/react'
import { Profiler } from 'react'
import {
  NativeChatProviderReceived,
  NativeChatSendingLabel
} from '../../../messages/rows/NativeChatProviderReceived'
import type { AppState } from '@/store/types'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import type { AgentSessionSubscribeEvent } from '../../../../../../../shared/agent-session/agent-session-wire'
import { agentJournalSubmissionKey } from '../../../../../../../shared/agent-session/journal/agent-session-journal-item-key'
import type {
  AgentJournalRenderItem,
  AgentJournalSubmission
} from '../../../../../../../shared/agent-session/journal/agent-session-journal-types'
import type { StructuredAgentSessionLiveSubscribe } from '../../../../../../../shared/agent-session/view/live-read/structured-agent-session-live-read-contract'
import { createReadOwner } from './structured-agent-session-read-owner-create'

const mock = vi.hoisted(() => {
  const streams: {
    params: Parameters<StructuredAgentSessionLiveSubscribe>[0]
    emit: Parameters<StructuredAgentSessionLiveSubscribe>[1]
  }[] = []
  return { visible: true, changed: new Set<() => void>(), streams }
})

vi.mock('@/lib/window-activity/window-park-visibility', () => ({
  getWindowParkVisible: () => mock.visible,
  subscribeWindowParkVisibility: (changed: () => void) => {
    mock.changed.add(changed)
    return () => mock.changed.delete(changed)
  }
}))
vi.mock('@/runtime/native-chat/requests/structured-agent-session-subscriptions', () => ({
  subscribeStructuredAgentSession: (
    _target: unknown,
    params: (typeof mock.streams)[number]['params'],
    emit: (typeof mock.streams)[number]['emit']
  ) => {
    mock.streams.push({ params, emit })
    return Promise.resolve({ unsubscribe: () => {} })
  }
}))
vi.mock('@/runtime/native-chat/requests/structured-agent-session-call', () => ({
  callStructuredAgentSession: async () => ({})
}))

beforeEach(() => {
  vi.useFakeTimers()
  mock.visible = true
  mock.streams.length = 0
})
afterEach(() => {
  mock.changed.clear()
  vi.useRealTimers()
})

const options = {
  getState: () => {
    // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: the seeded owner reads only settings.
    return { settings: null } as AppState
  },
  subscribeRetryNow: () => () => {}
}

const submission: AgentJournalSubmission = {
  clientMessageId: 'send',
  fence: 1,
  dispatchState: 'pending',
  payloadFingerprint: 'fingerprint',
  providerItemId: null,
  reason: null,
  submittedAt: 1,
  handedOverAt: 2,
  resolvedAt: null
}

const itemId = agentJournalSubmissionKey('send')
const row = (sequence: number, role: 'user' | 'assistant', id: string): AgentJournalRenderItem => ({
  itemId: id,
  sequence,
  revision: 1,
  observedAt: sequence,
  body: { kind: 'message', role, blocks: [{ type: 'text', text: 'Hello' }] }
})

function counted<T>(array: T[], visit: () => void): T[] {
  const observed = array.slice()
  for (const [index, item] of array.entries()) {
    Object.defineProperty(observed, index, {
      get: () => {
        visit()
        return item
      }
    })
  }
  return observed
}

// PR #51346: a standalone receipt must touch only its indexed pending send.
it.each([4096, 40960])('applies one receipt without visiting %i loaded rows', (size) => {
  const run = (acknowledge: boolean) => {
    const owner = createReadOwner(`local:${size}:${acknowledge}`, 'chat', { kind: 'local' })
    const epoch = 'epoch'
    const cursor = { epoch, sequence: size }
    owner.publishCreated({
      sessionId: 'chat',
      epoch,
      fence: 1,
      direction: 'before',
      window: { oldest: null, newest: cursor, nextCursor: cursor },
      items: Array.from({ length: size - 1 }, (_, i) => row(i + 1, 'assistant', `row-${i}`)),
      submissions: [],
      removedItemIds: [],
      hasOlder: false,
      hasNewer: false
    })
    owner.activate({ ...options, showsReplyText: true })
    const { emit } = mock.streams.at(-1)!
    const batch = {
      type: 'batch',
      sessionId: 'chat',
      fence: 1,
      batch: { cursor, items: [], removedItemIds: [], submissions: [] }
    } satisfies AgentSessionSubscribeEvent
    emit(batch)
    const handover = {
      ...batch,
      batch: { ...batch.batch, items: [row(size, 'user', itemId)], submissions: [submission] }
    }
    const renders = vi.fn()
    const labels = acknowledge
      ? render(
          <NativeChatProviderReceived value={{ labels: owner.receipts!, agent: 'claude' }}>
            <Profiler id="match" onRender={renders}>
              <NativeChatSendingLabel itemId={itemId} />
            </Profiler>
            <Profiler id="other" onRender={renders}>
              <NativeChatSendingLabel itemId="unrelated" />
            </Profiler>
          </NativeChatProviderReceived>
        )
      : undefined
    act(() => emit(handover))
    const state = owner.getSnapshot().state
    expect(state.items).toHaveLength(size)
    const notify = vi.fn()
    owner.subscribe(notify)
    let rows = 0
    let submissions = 0
    const retainedItems = counted(state.items, () => rows++)
    const retainedSubmissions = counted(state.submissions, () => submissions++)
    state.items = retainedItems
    state.submissions = retainedSubmissions
    if (labels) {
      renders.mockClear()
      const stamp = { ...batch, providerReceived: [size] }
      const snapshot = owner.getSnapshot()
      act(() => emit(stamp))
      expect(renders.mock.calls.map(([id]) => id)).toEqual(['match'])
      expect(labels.getByText('Received by Claude')).toBeDefined()
      act(() => {
        emit(stamp)
        emit({ ...batch, providerReceived: [size - 1] })
      })
      expect(renders).toHaveBeenCalledTimes(1)
      expect(owner.getSnapshot()).toBe(snapshot)
      expect(notify).not.toHaveBeenCalled()
      labels.unmount()
      expect(snapshot.state.items).toBe(retainedItems)
      expect(snapshot.state.submissions).toBe(retainedSubmissions)
      expect([rows, submissions, vi.getTimerCount()]).toEqual([0, 0, 0])
    }
    notify.mockClear()
    emit({
      ...batch,
      batch: {
        ...batch.batch,
        cursor: { epoch, sequence: size + 1 },
        submissions: [{ ...submission, dispatchState: 'accepted', resolvedAt: 3 }]
      }
    })
    vi.advanceTimersByTime(48)
    expect(notify).toHaveBeenCalledTimes(1)
    expect(owner.receipts?.provider(itemId)).toBeUndefined()
    owner.dispose()
    return [rows, submissions]
  }
  expect(run(true)).toEqual(run(false))
})

// PR #51346: trimming history with no pending receipt rows does not read discarded item IDs.
it.each([4096, 40960])('does not copy %i discarded row IDs on trim', (discarded) => {
  const owner = createReadOwner(`trim:${discarded}`, 'chat', { kind: 'local' })
  const cursor = { epoch: 'epoch', sequence: discarded + 4096 }
  let discardedIdReads = 0
  owner.publishCreated({
    sessionId: 'chat',
    epoch: cursor.epoch,
    direction: 'tail',
    window: { oldest: null, newest: cursor, nextCursor: cursor },
    hasOlder: true,
    hasNewer: false,
    removedItemIds: [],
    submissions: [],
    items: Array.from({ length: cursor.sequence }, (_, index) => {
      const id = String(index)
      const item = { ...row(index + 1, 'assistant', id), agentId: 'child' }
      if (index < discarded) {
        Object.defineProperty(item, 'itemId', {
          get: () => {
            discardedIdReads++
            return id
          }
        })
      }
      return item
    })
  })
  discardedIdReads = 0
  owner.trimHistory()
  expect(owner.getSnapshot().state.items).toHaveLength(4096)
  expect(discardedIdReads).toBe(0)
  owner.dispose()
})

// PR #51346: changing document visibility keeps the existing journal subscription and paging.
it.each([false, true])('keeps one stream with transcript opened first = %s', (transcriptFirst) => {
  const owner = createReadOwner('local:chat:interest', 'chat', { kind: 'local' })
  const cursor = { epoch: 'epoch', sequence: 0 }
  owner.publishCreated({
    sessionId: 'chat',
    epoch: cursor.epoch,
    fence: 1,
    direction: 'tail',
    window: { oldest: null, newest: null, nextCursor: cursor },
    items: [],
    submissions: [],
    removedItemIds: [],
    hasOlder: false,
    hasNewer: false
  })
  owner.activate({ ...options, showsReplyText: transcriptFirst })
  owner.activate({ ...options, showsReplyText: !transcriptFirst })
  const { emit } = mock.streams[0]!
  expect(mock.streams).toHaveLength(1)
  emit({
    type: 'batch',
    sessionId: 'chat',
    fence: 1,
    batch: { cursor, items: [], removedItemIds: [], submissions: [] }
  })
  const snapshot = owner.getSnapshot()
  expect(snapshot.current).toBe(true)
  for (const visible of [false, true]) {
    mock.visible = visible
    document.dispatchEvent(new Event('visibilitychange'))
    Array.from(mock.changed).forEach((changed) => changed())
    expect(mock.streams).toHaveLength(1)
    expect(owner.getSnapshot()).toBe(snapshot)
  }
  owner.dispose()
  expect(mock.changed.size).toBe(0)
})
