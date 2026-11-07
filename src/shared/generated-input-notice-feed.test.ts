import { expect, it, vi } from 'vitest'
import {
  createGeneratedInputNoticeFeed,
  type GeneratedInputNoticeDelta
} from './generated-input-notice-feed'
import {
  generatedInputNoticeFrames,
  type GeneratedAgentInputNotice
} from './generated-agent-input-notice'

function notice(id: string): GeneratedAgentInputNotice {
  return {
    id,
    agent: 'claude',
    text: 'exact text',
    certainty: 'not-sent',
    handle: 'terminal',
    worktreeId: 'workspace',
    ptyId: null
  }
}

it.each([100, 1_000])(
  'publishes changed metadata as one delta at %i records and keeps unchanged identities',
  async (population) => {
    const initial = Array.from({ length: population }, (_, index) => notice(String(index)))
    const view = new Map<string, GeneratedAgentInputNotice>()
    const onDelta = vi.fn((delta: GeneratedInputNoticeDelta) => {
      if (delta.kind === 'added') {
        view.set(delta.notice.id, delta.notice)
      }
    })
    let snapshotDone!: () => void
    const ready = new Promise<void>((resolve) => {
      snapshotDone = resolve
    })
    const feed = createGeneratedInputNoticeFeed({
      readPage: async () => ({
        session: 'host',
        revision: 0,
        next: null,
        frames: initial.flatMap((entry) => generatedInputNoticeFrames(entry).frames)
      }),
      onSnapshot: (notices) => {
        notices.forEach((entry) => view.set(entry.id, entry))
        snapshotDone()
      },
      onDelta
    })
    feed.receive({ type: 'ready', session: 'host', revision: 0 })
    await ready
    const unchanged = view.get('1')
    const changed = {
      ...initial[0],
      certainty: 'unconfirmed' as const,
      handle: 'resolved',
      ptyId: 'pty',
      worktreeId: 'resolved-workspace'
    }
    const [frame] = generatedInputNoticeFrames(changed).frames
    feed.receive({ type: 'notice', session: 'host', revision: 1, frame })
    expect(onDelta).toHaveBeenCalledExactlyOnceWith({ kind: 'added', notice: changed }, 'host')
    expect(view.get('0')).toEqual(changed)
    expect(view.get('1')).toBe(unchanged)
    feed.receive({ type: 'notice', session: 'host', revision: 1, frame })
    expect(onDelta).toHaveBeenCalledTimes(1)
    feed.stop()
  }
)

it('keeps newer live metadata when an older snapshot finishes later', async () => {
  const original = notice('operation')
  const updated = { ...original, certainty: 'unconfirmed' as const, handle: 'resolved' }
  let release!: (page: unknown) => void
  let completed!: () => void
  const done = new Promise<void>((resolve) => {
    completed = resolve
  })
  const onSnapshot = vi.fn(() => completed())
  const feed = createGeneratedInputNoticeFeed({
    readPage: () =>
      new Promise((resolve) => {
        release = resolve
      }),
    onSnapshot,
    onDelta: vi.fn()
  })
  feed.receive({ type: 'ready', session: 'host', revision: 0 })
  for (const frame of generatedInputNoticeFrames(updated).frames) {
    feed.receive({ type: 'notice', session: 'host', revision: 1, frame })
  }
  release({
    session: 'host',
    revision: 0,
    next: null,
    frames: generatedInputNoticeFrames(original).frames
  })
  await done
  expect(onSnapshot).toHaveBeenCalledExactlyOnceWith([updated], 'host', [])
  feed.stop()
})

it('collects private suppression from every bounded page before publishing the snapshot', async () => {
  let completed!: () => void
  const done = new Promise<void>((resolve) => {
    completed = resolve
  })
  const onSnapshot = vi.fn(() => completed())
  const readPage = vi.fn(async (from: { cursor: number; offset: number } | undefined) =>
    from
      ? { session: 'host', revision: 0, frames: [], next: null, withheld: ['second'] }
      : {
          session: 'host',
          revision: 0,
          frames: [],
          next: { cursor: 0, offset: 1 },
          withheld: ['first']
        }
  )
  const feed = createGeneratedInputNoticeFeed({ readPage, onSnapshot, onDelta: vi.fn() })
  feed.receive({ type: 'ready', session: 'host', revision: 0 })
  await done
  expect(readPage).toHaveBeenCalledTimes(2)
  expect(onSnapshot).toHaveBeenCalledExactlyOnceWith([], 'host', ['first', 'second'])
  feed.stop()
})

it('remembers a real wake during a failed snapshot and fences a stopped successor', async () => {
  let reject!: (error: Error) => void
  let finish!: (page: unknown) => void
  const onSnapshot = vi.fn()
  const readPage = vi
    .fn()
    .mockImplementationOnce(
      () =>
        new Promise((_resolve, fail) => {
          reject = fail
        })
    )
    .mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          finish = resolve
        })
    )
  const feed = createGeneratedInputNoticeFeed({ readPage, onSnapshot, onDelta: vi.fn() })
  feed.receive({ type: 'ready', session: 'host', revision: 0 })
  feed.retry()
  expect(readPage).toHaveBeenCalledTimes(1)
  reject(new Error('temporary page failure'))
  await vi.waitFor(() => expect(readPage).toHaveBeenCalledTimes(2))
  feed.stop()
  finish({ session: 'host', revision: 0, frames: [], next: null, withheld: ['discarded'] })
  await Promise.resolve()
  expect(onSnapshot).not.toHaveBeenCalled()
  feed.retry()
  expect(readPage).toHaveBeenCalledTimes(2)
})
