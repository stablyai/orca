import { toast } from 'sonner'
import { beforeEach, expect, it, vi } from 'vitest'
import { announceRestartResults } from './native-chat-restart-action-notifications'

vi.mock('sonner', () => ({ toast: vi.fn() }))

const actions = { show: vi.fn(), dismiss: vi.fn() }
const refusedBoth = [
  { sessionId: 'a', outcome: 'refused' as const },
  { sessionId: 'b', outcome: 'refused' as const }
]

beforeEach(() => vi.mocked(toast).mockClear())

// `b` finished on its own, or the user already answered it: the host no longer lists it, so the
// notice must not count a failure the list it opens cannot show.
it('counts only the requested chats the host still lists as failed', () => {
  announceRestartResults(['a', 'b'], refusedBoth, [{ sessionId: 'a', outcome: 'refused' }], actions)
  expect(vi.mocked(toast).mock.calls.map(([text]) => text)).toEqual(['1 chat couldn’t be resumed'])
})

it('says nothing when the host lists none of them as failed', () => {
  announceRestartResults(['a', 'b'], refusedBoth, [], actions)
  expect(toast).not.toHaveBeenCalled()
})

it('counts every chat not carried on when an older host sends no failure list', () => {
  announceRestartResults(['a', 'b'], refusedBoth, undefined, actions)
  expect(vi.mocked(toast).mock.calls.map(([text]) => text)).toEqual(['2 chats couldn’t be resumed'])
})

// The host retires an unconfirmed send once the agent is seen carrying on it; the action must still
// report the chat, and as resumed, not as a failure the list can no longer show.
it('counts an unconfirmed chat the host no longer lists as resumed', () => {
  announceRestartResults(['a'], [{ sessionId: 'a', outcome: 'unknown' }], [], actions)
  expect(vi.mocked(toast).mock.calls.map(([text]) => text)).toEqual([
    'Resumed 1 chat and asked it to continue'
  ])
})

// Unconfirmed means the agent may well be working; "couldn't be resumed" would invite a second send.
// `b` reattached with no continuation row: only the host's filed outcome says it is unconfirmed.
it('counts a chat the host filed as unconfirmed on its own line, as the list does', () => {
  announceRestartResults(
    ['a', 'b'],
    [{ sessionId: 'a', outcome: 'refused' }],
    [
      { sessionId: 'a', outcome: 'refused' },
      { sessionId: 'b', outcome: 'unconfirmed' }
    ],
    actions
  )
  expect(vi.mocked(toast).mock.calls).toEqual([
    [
      '1 chat couldn’t be resumed',
      expect.objectContaining({ description: 'Couldn’t confirm 1 other chat was resumed' })
    ]
  ])
})

it('leads with the unconfirmed count when nothing was refused', () => {
  announceRestartResults(
    ['a', 'b'],
    [
      { sessionId: 'a', outcome: 'unknown' },
      { sessionId: 'b', outcome: 'pending' }
    ],
    undefined,
    actions
  )
  expect(vi.mocked(toast).mock.calls).toEqual([
    [
      'Couldn’t confirm 2 chats were resumed',
      expect.not.objectContaining({ description: expect.anything() })
    ]
  ])
})
