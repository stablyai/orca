import { describe, expect, it } from 'vitest'
import type { GitBlameResult } from '../../../shared/git-blame'
import { enqueueGitBlameRequest } from './git-blame-request-queue'

const READY: GitBlameResult = { status: 'ready', lines: [] }

function deferred() {
  let resolve!: () => void
  const promise = new Promise<GitBlameResult>((res) => {
    resolve = () => res(READY)
  })
  return { promise, resolve }
}

describe('enqueueGitBlameRequest', () => {
  it('runs at most two requests at once and drops cancelled queued ones', async () => {
    const started: string[] = []
    const gates = { a: deferred(), b: deferred(), c: deferred(), d: deferred() }
    const run = (name: keyof typeof gates) => () => {
      started.push(name)
      return gates[name].promise
    }
    const a = enqueueGitBlameRequest(run('a'))
    const b = enqueueGitBlameRequest(run('b'))
    const c = enqueueGitBlameRequest(run('c'))
    const d = enqueueGitBlameRequest(run('d'))
    expect(started).toEqual(['a', 'b'])

    c.cancel()
    await expect(c.promise).resolves.toBeNull()

    gates.a.resolve()
    await a.promise
    await new Promise((resolve) => setTimeout(resolve, 0))
    expect(started).toEqual(['a', 'b', 'd'])

    gates.b.resolve()
    gates.d.resolve()
    await Promise.all([b.promise, d.promise])
    expect(started).toEqual(['a', 'b', 'd'])
  })

  it('starts queued requests oldest first so later arrivals cannot starve them', async () => {
    const started: string[] = []
    const gates = {
      a: deferred(),
      b: deferred(),
      old: deferred(),
      mid: deferred(),
      late: deferred()
    }
    const run = (name: keyof typeof gates) => () => {
      started.push(name)
      return gates[name].promise
    }
    enqueueGitBlameRequest(run('a'))
    enqueueGitBlameRequest(run('b'))
    enqueueGitBlameRequest(run('old'))
    enqueueGitBlameRequest(run('mid'))
    enqueueGitBlameRequest(run('late'))

    gates.a.resolve()
    await new Promise((resolve) => setTimeout(resolve, 0))
    gates.b.resolve()
    await new Promise((resolve) => setTimeout(resolve, 0))
    expect(started).toEqual(['a', 'b', 'old', 'mid'])

    // Why: the queue is module state, so drain it for the next test.
    gates.old.resolve()
    gates.mid.resolve()
    gates.late.resolve()
    await new Promise((resolve) => setTimeout(resolve, 0))
  })

  it('promote moves a queued request ahead of older ones', async () => {
    const started: string[] = []
    const gates = { a: deferred(), b: deferred(), old: deferred(), focused: deferred() }
    const run = (name: keyof typeof gates) => () => {
      started.push(name)
      return gates[name].promise
    }
    enqueueGitBlameRequest(run('a'))
    enqueueGitBlameRequest(run('b'))
    enqueueGitBlameRequest(run('old'))
    const focused = enqueueGitBlameRequest(run('focused'))

    focused.promote()
    gates.a.resolve()
    await new Promise((resolve) => setTimeout(resolve, 0))
    expect(started).toEqual(['a', 'b', 'focused'])

    gates.b.resolve()
    gates.focused.resolve()
    await new Promise((resolve) => setTimeout(resolve, 0))
    gates.old.resolve()
    await new Promise((resolve) => setTimeout(resolve, 0))
    expect(started).toEqual(['a', 'b', 'focused', 'old'])
  })

  it('promote is a no-op for a running or finished request', async () => {
    const started: string[] = []
    const gates = { a: deferred(), b: deferred(), c: deferred() }
    const run = (name: keyof typeof gates) => () => {
      started.push(name)
      return gates[name].promise
    }
    const a = enqueueGitBlameRequest(run('a'))
    enqueueGitBlameRequest(run('b'))
    enqueueGitBlameRequest(run('c'))

    a.promote()
    expect(started).toEqual(['a', 'b'])

    gates.a.resolve()
    await a.promise
    await new Promise((resolve) => setTimeout(resolve, 0))
    a.promote()
    expect(started).toEqual(['a', 'b', 'c'])

    gates.b.resolve()
    gates.c.resolve()
    await new Promise((resolve) => setTimeout(resolve, 0))
  })
})
