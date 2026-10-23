// @vitest-environment happy-dom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { scrollTopCache, setWithLRU } from '@/lib/scroll-cache'
import {
  checkDetailsReadingKey,
  checkLogDigest,
  checkReadingIntentKey,
  checkReadingLogKey,
  checkReadingOuterKey,
  checkReadingStepsKey,
  reconcileCheckDetailsReadingCache
} from './check-details-reading-cache'
import { createCheckDetailsReadingOwner } from './check-details-reading-owner'
import { attachCheckReadingViewport } from './check-details-reading-viewport'
import {
  measuredReadingNode,
  readingDetails,
  readingFile,
  readingFixture
} from './check-details-reading-fixture'
import * as digest from '@/lib/sha256'

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
  it.each([false, true])(
    'allows first payload navigation only while deliberate intent survives, cancelled=%s',
    (cancelled) => {
      const { owner, store, file, identity, text, logKey } = readingFixture()
      const pending = { ...file.checkRunDetails!, details: null }
      store.setState({ openFiles: [{ ...file, checkRunDetails: pending }] })
      reconcileCheckDetailsReadingCache(file.id, undefined, pending, () => true)
      const detachOwner = owner.attach()
      const outer = measuredReadingNode()
      const detachOuter = attachCheckReadingViewport({
        node: outer,
        owner,
        cacheKey: checkReadingOuterKey(owner.key)
      })
      if (cancelled) {
        fireReading(outer)
      }
      const next = file.checkRunDetails!
      store.setState({ openFiles: [file] })
      reconcileCheckDetailsReadingCache(file.id, pending, next, () => true)
      const node = measuredReadingNode(text)
      const initial = vi.fn(() => 600)
      const detach = attachCheckReadingViewport({
        node,
        owner,
        cacheKey: logKey,
        job: identity,
        text,
        initial,
        consumeIntent: () => {
          const eligible = owner.claim(identity)
          scrollTopCache.delete(checkReadingIntentKey(owner.key, identity))
          return eligible
        }
      })
      expect(initial).toHaveBeenCalledTimes(cancelled ? 0 : 1)
      expect(node.scrollTop).toBe(cancelled ? 0 : 600)
      detach()
      detachOuter()
      detachOwner()
    }
  )

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

  it('settled outer scrolling scans no cache keys and invokes no setup work', () => {
    const { owner, store, identity, text } = readingFixture()
    const node = measuredReadingNode()
    const detachOwner = owner.attach()
    const cancel = vi.fn()
    const unregister = owner.register({
      job: identity,
      text,
      start: () => {},
      retire: () => undefined,
      cancel
    })
    const initial = vi.fn(() => 400)
    const detach = attachCheckReadingViewport({
      node,
      owner,
      cacheKey: checkReadingOuterKey(owner.key),
      initial
    })
    fireReading(node)
    const keys = vi.spyOn(scrollTopCache, 'keys')
    for (let index = 0; index < 100; index++) {
      node.scrollTop = index
      node.dispatchEvent(new Event('scroll'))
      store.setState({ unrelated: index })
    }
    expect(keys).not.toHaveBeenCalled()
    expect(initial).not.toHaveBeenCalled()
    expect(cancel).toHaveBeenCalledTimes(1)
    detach()
    unregister()
    detachOwner()
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

  it('saves a valid zero in a measurable short document', () => {
    const { owner, logKey, text, identity } = readingFixture()
    const node = measuredReadingNode(text)
    Object.defineProperty(node, 'scrollHeight', { value: 100 })
    setWithLRU(scrollTopCache, logKey, 180)
    const detachOwner = owner.attach()
    const detach = attachCheckReadingViewport({
      node,
      owner,
      cacheKey: logKey,
      job: identity,
      text
    })
    expect(scrollTopCache.get(logKey)).toBe(0)
    detach()
    detachOwner()
  })

  it('consumes an unmeasurable initial attempt once and cancels its sole frame on teardown', () => {
    const { owner, logKey, text, identity } = readingFixture()
    const node = measuredReadingNode(text, 0)
    const initial = vi.fn(() => 700)
    const detachOwner = owner.attach()
    const detach = attachCheckReadingViewport({
      node,
      owner,
      cacheKey: logKey,
      job: identity,
      text,
      initial,
      consumeIntent: () => true
    })
    expect(frames.size).toBe(1)
    flushFrames()
    expect(scrollTopCache.get(logKey)).toBe(0)
    Object.defineProperty(node, 'clientHeight', { configurable: true, value: 200 })
    node.dispatchEvent(new Event('resize'))
    node.dispatchEvent(new Event('scroll'))
    expect(initial).not.toHaveBeenCalled()
    detach()
    detachOwner()
    expect(frames.size).toBe(0)
  })

  it('advances the watermark on another file dirty/save update and restores the later scroll', () => {
    const { owner, store, logKey, text, identity } = readingFixture()
    const detachOwner = owner.attach()
    const node = measuredReadingNode(text)
    const options = { node, owner, cacheKey: logKey, job: identity, text }
    const detach = attachCheckReadingViewport(options)
    store.setState({
      openFiles: [
        ...store.getState().openFiles,
        { ...readingFile(), id: 'other', mode: 'edit', isDirty: true }
      ]
    })
    store.setState({
      openFiles: store
        .getState()
        .openFiles.map((file) => (file.id === 'other' ? { ...file, isDirty: false } : file))
    })
    node.scrollTop = 450
    node.dispatchEvent(new Event('scroll'))
    detach()
    node.scrollTop = 0
    const remount = attachCheckReadingViewport(options)
    expect(node.scrollTop).toBe(450)
    remount()
    detachOwner()
  })

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

  it('cancels first-payload and job intent with reading input, but ignores bubbled control clicks', () => {
    const { owner, file, text, identity } = readingFixture()
    reconcileCheckDetailsReadingCache(file.id, undefined, file.checkRunDetails!, () => true)
    const unclaimed = checkReadingIntentKey(
      checkDetailsReadingKey(file.id, null, 'context'),
      identity
    )
    const node = measuredReadingNode(text)
    const button = document.createElement('button')
    node.append(button)
    const detachOwner = owner.attach()
    const detach = attachCheckReadingViewport({
      node,
      owner,
      cacheKey: checkReadingOuterKey(owner.key)
    })
    button.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true }))
    expect(scrollTopCache.get(unclaimed)).toBe(-1)
    node.dispatchEvent(new WheelEvent('wheel'))
    expect(scrollTopCache.has(unclaimed)).toBe(false)
    detach()
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

  it('shares the real 20-entry LRU across two five-job panes and ordinary editor keys', () => {
    const { store, file, identity, text } = readingFixture()
    const first = createCheckDetailsReadingOwner(store, file.id, 'left', 'context')
    const second = createCheckDetailsReadingOwner(store, file.id, 'right', 'context')
    for (let index = 0; index < 8; index++) {
      setWithLRU(scrollTopCache, `ordinary-${index}`, index)
    }
    for (const owner of [first, second]) {
      setWithLRU(scrollTopCache, checkReadingOuterKey(owner.key), 320)
      for (let index = 0; index < 5; index++) {
        setWithLRU(
          scrollTopCache,
          checkReadingLogKey(owner.key, `${identity}-${index}`, checkLogDigest(text)),
          180
        )
        setWithLRU(scrollTopCache, checkReadingStepsKey(owner.key, `${identity}-${index}`, true), 0)
        expect(scrollTopCache.size).toBeLessThanOrEqual(20)
      }
    }
    expect(scrollTopCache.size).toBe(20)
    expect(scrollTopCache.has(checkReadingOuterKey(first.key))).toBe(false)
    expect([...scrollTopCache.values()].every((value) => typeof value === 'number')).toBe(true)
    expect([...scrollTopCache.keys()].some((key) => key.includes(text))).toBe(false)
    const detachOwner = first.attach()
    const node = measuredReadingNode()
    const initial = vi.fn(() => 600)
    const detach = attachCheckReadingViewport({
      node,
      owner: first,
      cacheKey: checkReadingOuterKey(first.key),
      initial
    })
    expect(node.scrollTop).toBe(0)
    expect(initial).not.toHaveBeenCalled()
    detach()
    detachOwner()
  })
})

function fireReading(node: HTMLElement): void {
  node.dispatchEvent(new WheelEvent('wheel'))
}
