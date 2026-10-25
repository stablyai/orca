import { isValidElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { toast } from 'sonner'
import { beforeEach, expect, it, vi } from 'vitest'
import { announceRestartResults } from './native-chat-restart-action-notifications'
import { lastToastShow } from './native-chat-resume-toast.test-support'

vi.mock('sonner', async () =>
  (await import('./native-chat-resume-sonner-mock.test-support')).resumeSonnerMock()
)

const show = vi.fn()
const refusedBoth = [
  { sessionId: 'a', outcome: 'refused' as const },
  { sessionId: 'b', outcome: 'refused' as const }
]

beforeEach(() => vi.clearAllMocks())

function titles(): unknown[] {
  return vi.mocked(toast).mock.calls.map(([text]) => text)
}

it.each([true, false])('offers View chats on a success toast with a failure list: %s', (listed) => {
  announceRestartResults(
    ['a', 'b'],
    [
      { sessionId: 'a', outcome: 'continued' },
      { sessionId: 'b', outcome: 'continued' }
    ],
    listed ? [] : undefined,
    show
  )
  expect(titles()).toEqual(['Resumed 2 chats'])
  expect(toast.success).toHaveBeenCalledTimes(1)
  expect(vi.mocked(toast).mock.calls[0]?.[1]?.action).toEqual({
    label: 'View chats',
    onClick: expect.any(Function)
  })
  expect(lastToastShow()).toBeDefined()
})

it('offers Review on an error toast for chats a resume could not carry on', () => {
  announceRestartResults(['a', 'b'], refusedBoth, refusedBoth, show)
  expect(titles()).toEqual(['2 chats couldn’t be resumed'])
  const options = vi.mocked(toast).mock.calls[0]?.[1]
  expect(options).not.toHaveProperty('description')
  expect(toast.error).toHaveBeenCalledTimes(1)
  expect(options?.action).toEqual({ label: 'Review', onClick: expect.any(Function) })
  lastToastShow()?.()
  expect(show).toHaveBeenCalledTimes(1)
})

it('offers Review on a warning toast when a resume could not be confirmed', () => {
  announceRestartResults(
    ['a', 'b'],
    [
      { sessionId: 'a', outcome: 'continued' },
      { sessionId: 'b', outcome: 'unknown' }
    ],
    [{ sessionId: 'b', outcome: 'unconfirmed' }],
    show
  )
  expect(titles()).toEqual(['Couldn’t confirm 1 chat was resumed'])
  expect(toast.warning).toHaveBeenCalledTimes(1)
  expect(vi.mocked(toast).mock.calls[0]?.[1]?.action).toEqual({
    label: 'Review',
    onClick: expect.any(Function)
  })
})

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

it('counts only the requested chats the host still lists as failed', () => {
  announceRestartResults(['a', 'b'], refusedBoth, [{ sessionId: 'a', outcome: 'refused' }], show)
  expect(titles()).toEqual(['1 chat couldn’t be resumed'])
})

it('says nothing when the host lists none of them as failed', () => {
  announceRestartResults(['a', 'b'], refusedBoth, [], show)
  expect(toast).not.toHaveBeenCalled()
})

it('counts every chat not carried on when no failure list was read, with nothing to open', () => {
  announceRestartResults(['a', 'b'], [], undefined, show)
  expect(titles()).toEqual(['2 chats couldn’t be resumed'])
  expect(vi.mocked(toast).mock.calls[0]?.[1]).not.toHaveProperty('action')
})

it('counts every chat as unconfirmed when the answer carried no outcomes', () => {
  announceRestartResults(['a', 'b'], undefined, undefined, show)
  expect(titles()).toEqual(['Couldn’t confirm 2 chats were resumed'])
})

it('counts an unconfirmed chat the host no longer lists as resumed', () => {
  announceRestartResults(['a'], [{ sessionId: 'a', outcome: 'unknown' }], [], show)
  expect(titles()).toEqual(['Resumed 1 chat'])
})

// Unconfirmed sends may already be running; use the host’s recorded outcome to avoid inviting duplicate sends.
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
