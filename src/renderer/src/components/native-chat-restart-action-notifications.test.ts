import { isValidElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { toast } from 'sonner'
import { beforeEach, expect, it, vi } from 'vitest'
import { announceRestartResults } from './native-chat-restart-action-notifications'
import { lastToastShow } from './native-chat-resume-toast.test-support'

vi.mock('sonner', () => ({ toast: vi.fn() }))

const show = vi.fn()
const refusedBoth = [
  { sessionId: 'a', outcome: 'refused' as const },
  { sessionId: 'b', outcome: 'refused' as const }
]

beforeEach(() => vi.mocked(toast).mockClear())

function titles(): unknown[] {
  return vi.mocked(toast).mock.calls.map(([text]) => text)
}

it('says how many chats were resumed', () => {
  announceRestartResults(
    ['a', 'b'],
    [
      { sessionId: 'a', outcome: 'continued' },
      { sessionId: 'b', outcome: 'continued' }
    ],
    [],
    show
  )
  expect(vi.mocked(toast).mock.calls).toEqual([['Resumed 2 chats']])
})

it('offers Show for chats a resume could not carry on', () => {
  announceRestartResults(['a', 'b'], refusedBoth, refusedBoth, show)
  expect(titles()).toEqual(['2 chats couldn’t be resumed'])
  const options = vi.mocked(toast).mock.calls[0]?.[1]
  expect(options).not.toHaveProperty('description')
  expect(options?.action).toEqual({ label: 'Show', onClick: expect.any(Function) })
  lastToastShow()?.()
  expect(show).toHaveBeenCalledTimes(1)
})

// One resume, one toast: the chats it resumed ride along under the ones it could not.
it('reports a mixed resume in one toast', () => {
  announceRestartResults(
    ['a', 'b', 'c'],
    [
      { sessionId: 'a', outcome: 'continued' },
      { sessionId: 'b', outcome: 'continued' },
      { sessionId: 'c', outcome: 'refused' }
    ],
    [{ sessionId: 'c', outcome: 'refused' }],
    show
  )
  expect(vi.mocked(toast).mock.calls).toEqual([
    ['1 chat couldn’t be resumed', expect.objectContaining({ description: 'Resumed 2 chats' })]
  ])
})

it('puts each extra count on its own line when a resume had all three outcomes', () => {
  announceRestartResults(
    ['a', 'b', 'c'],
    [
      { sessionId: 'a', outcome: 'continued' },
      { sessionId: 'b', outcome: 'refused' },
      { sessionId: 'c', outcome: 'unknown' }
    ],
    [
      { sessionId: 'b', outcome: 'refused' },
      { sessionId: 'c', outcome: 'unconfirmed' }
    ],
    show
  )
  expect(toast).toHaveBeenCalledTimes(1)
  const [title, options] = vi.mocked(toast).mock.calls[0]!
  expect(title).toBe('1 chat couldn’t be resumed')
  const description = options?.description
  if (!isValidElement(description)) {
    throw new Error('Expected one line per count')
  }
  expect(renderToStaticMarkup(description)).toBe(
    '<span class="block">Couldn’t confirm 1 other chat was resumed</span>' +
      '<span class="block">Resumed 1 chat</span>'
  )
})

// `b` finished on its own, or the user already answered it: the host no longer lists it, so the
// notice must not count a failure the list it opens cannot show.
it('counts only the requested chats the host still lists as failed', () => {
  announceRestartResults(['a', 'b'], refusedBoth, [{ sessionId: 'a', outcome: 'refused' }], show)
  expect(titles()).toEqual(['1 chat couldn’t be resumed'])
})

it('says nothing when the host lists none of them as failed', () => {
  announceRestartResults(['a', 'b'], refusedBoth, [], show)
  expect(toast).not.toHaveBeenCalled()
})

// A request that never reached the host leaves no read to narrow by, so every chat it named failed.
it('counts every chat not carried on when no failure list was read, with nothing to Show', () => {
  announceRestartResults(['a', 'b'], [], undefined, show)
  expect(titles()).toEqual(['2 chats couldn’t be resumed'])
  expect(vi.mocked(toast).mock.calls[0]?.[1]).not.toHaveProperty('action')
})

// An answer without outcomes may still have sent the message.
it('counts every chat as unconfirmed when the answer carried no outcomes', () => {
  announceRestartResults(['a', 'b'], undefined, undefined, show)
  expect(titles()).toEqual(['Couldn’t confirm 2 chats were resumed'])
})

// The host retires an unconfirmed send once the agent is seen carrying on it; the resume must still
// report the chat, and as resumed, not as a failure the list can no longer show.
it('counts an unconfirmed chat the host no longer lists as resumed', () => {
  announceRestartResults(['a'], [{ sessionId: 'a', outcome: 'unknown' }], [], show)
  expect(titles()).toEqual(['Resumed 1 chat'])
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
    show
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
    show
  )
  expect(vi.mocked(toast).mock.calls).toEqual([
    [
      'Couldn’t confirm 2 chats were resumed',
      expect.not.objectContaining({ description: expect.anything() })
    ]
  ])
})
