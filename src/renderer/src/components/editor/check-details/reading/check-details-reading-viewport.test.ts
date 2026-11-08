// @vitest-environment happy-dom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { scrollTopCache, setWithLRU } from '@/lib/scroll-cache'
import {
  checkLogDigest,
  checkReadingLogKey,
  checkReadingOuterKey
} from './check-details-reading-cache'

import { attachCheckReadingViewport } from './check-details-reading-viewport'
import {
  measuredReadingNode,
  readingDetails,
  readingFixture
} from './check-details-reading-fixture'
import * as digest from '../../../../../../shared/sha256'

const frames = new Map<number, FrameRequestCallback>()
let nextFrame = 0
beforeEach(() => {
  scrollTopCache.clear()
  nextFrame = 0
  vi.stubGlobal(
    'requestAnimationFrame',
    vi.fn((callback: FrameRequestCallback) => {
      frames.set(++nextFrame, callback)
      return nextFrame
    })
  )
  vi.stubGlobal(
    'cancelAnimationFrame',
    vi.fn((id: number) => frames.delete(id))
  )
})
afterEach(() => {
  frames.clear()
  document.body.replaceChildren()
  vi.restoreAllMocks()
  vi.unstubAllGlobals()
})
function flushFrames(): void {
  const pending = [...frames.values()]
  frames.clear()
  for (const callback of pending) {
    callback(0)
  }
}

describe('owned reading positions', () => {
  it('retirement cancels a pending frame and rejects a captured callback after close and reopen', () => {
    const { owner, store, file, logKey, text, identity } = readingFixture()
    const node = measuredReadingNode(text, 0)
    setWithLRU(scrollTopCache, logKey, 180)
    const detachOwner = owner.attach()
    const detach = attachCheckReadingViewport({
      node,
      owner,
      cacheKey: logKey,
      job: identity,
      text
    })
    const callback = [...frames.values()][0]
    store.setState({ openFiles: [] })
    expect(frames.size).toBe(0)
    scrollTopCache.delete(logKey)
    store.setState({ openFiles: [file] })
    Object.defineProperty(node, 'clientHeight', { configurable: true, value: 200 })
    callback(0)
    node.dispatchEvent(new Event('scroll'))
    detach()
    detachOwner()
    expect(scrollTopCache.has(logKey)).toBe(false)
  })
  it.each(['outer', 'inner'])(
    'preserves retained %s target through zero layout and a real remount',
    (kind) => {
      const { owner, logKey, text, identity } = readingFixture()
      const key = kind === 'outer' ? checkReadingOuterKey(owner.key) : logKey
      const node = measuredReadingNode(kind === 'outer' ? '' : text)
      Object.defineProperty(node, 'clientHeight', { configurable: true, value: 0 })
      setWithLRU(scrollTopCache, key, 320)
      const detachOwner = owner.attach()
      const options = {
        node,
        owner,
        cacheKey: key,
        ...(kind === 'inner' ? { job: identity, text } : {})
      }
      const detach = attachCheckReadingViewport(options)
      flushFrames()
      Object.defineProperty(node, 'clientHeight', { configurable: true, value: 200 })
      node.dispatchEvent(new Event('scroll'))
      detach()
      expect(scrollTopCache.get(key)).toBe(320)
      const remount = attachCheckReadingViewport(options)
      expect(node.scrollTop).toBe(320)
      remount()
      detachOwner()
    }
  )

  it('fences callbacks published before the observer and never rewinds on a reentrant notification', () => {
    const { owner, store, file, logKey, text, identity } = readingFixture()
    const node = measuredReadingNode(text)
    let nested = false
    const before = store.subscribe(() => {
      node.scrollTop = 999
      node.dispatchEvent(new Event('scroll'))
      if (!nested) {
        nested = true
        store.setState({ openFiles: [] })
      }
    })
    const detachOwner = owner.attach()
    const detach = attachCheckReadingViewport({
      node,
      owner,
      cacheKey: logKey,
      job: identity,
      text
    })
    const writes = vi.spyOn(scrollTopCache, 'set')
    store.setState({ openFiles: [{ ...file, isDirty: true }] })
    expect(writes).not.toHaveBeenCalled()
    before()
    scrollTopCache.delete(logKey)
    store.setState({ openFiles: [file] })
    node.dispatchEvent(new Event('scroll'))
    detach()
    expect(scrollTopCache.has(logKey)).toBe(false)
    detachOwner()
  })

  it('retires a changed digest before handoff and prevents queued old callbacks from recreating it', () => {
    const { owner, store, file, logKey, text, identity } = readingFixture()
    const node = measuredReadingNode(text)
    const detachOwner = owner.attach()
    const detach = attachCheckReadingViewport({
      node,
      owner,
      cacheKey: logKey,
      job: identity,
      text
    })
    node.scrollTop = 180
    node.dispatchEvent(new Event('scroll'))
    const details = readingDetails('Error: accepted new text')
    const next = { ...file.checkRunDetails!, details }
    store.setState({ openFiles: [{ ...file, checkRunDetails: next }] })
    const destination = checkReadingLogKey(
      owner.key,
      identity,
      checkLogDigest(details.jobs[0].logTail ?? '')
    )
    expect(scrollTopCache.get(destination)).toBe(180)
    node.scrollTop = 900
    node.dispatchEvent(new Event('scroll'))
    detach()
    flushFrames()
    expect(scrollTopCache.has(logKey)).toBe(false)
    expect(scrollTopCache.get(destination)).toBe(180)
    detachOwner()
  })

  it('does no hashing, marker work, Range work or frame scheduling during 100 scroll/unrelated notifications', () => {
    const { owner, store, logKey, text, identity } = readingFixture()
    const node = measuredReadingNode(text)
    const add = vi.spyOn(node, 'addEventListener')
    const remove = vi.spyOn(node, 'removeEventListener')
    const detachOwner = owner.attach()
    const detach = attachCheckReadingViewport({
      node,
      owner,
      cacheKey: logKey,
      job: identity,
      text
    })
    const hash = vi.spyOn(digest, 'sha256')
    const range = vi.spyOn(document, 'createRange')
    for (let index = 1; index <= 100; index++) {
      node.scrollTop = index
      node.dispatchEvent(new Event('scroll'))
      store.setState({ unrelated: index })
    }
    expect(scrollTopCache.get(logKey)).toBe(100)
    expect(hash).not.toHaveBeenCalled()
    expect(range).not.toHaveBeenCalled()
    expect(requestAnimationFrame).not.toHaveBeenCalled()
    detach()
    detachOwner()
    expect(remove.mock.calls.map(([name]) => name)).toEqual(add.mock.calls.map(([name]) => name))
  })
})
