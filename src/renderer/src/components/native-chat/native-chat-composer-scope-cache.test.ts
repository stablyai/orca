import { describe, expect, it } from 'vitest'
import {
  NATIVE_CHAT_COMPOSER_SCOPE_CACHE_MAX,
  createNativeChatScopeCacheController
} from './native-chat-composer-scope-cache'

function createController(
  overrides: Partial<Parameters<typeof createNativeChatScopeCacheController>[0]> = {}
): ReturnType<typeof createNativeChatScopeCacheController> {
  return createNativeChatScopeCacheController({
    maxEntriesPerCache: 128,
    maxAggregateBytes: 100,
    maxValueBytes: 80,
    maxKeyBytes: 20,
    ...overrides
  })
}

describe('native-chat scope cache retention', () => {
  it('retains values and keys exactly at their individual limits', () => {
    const controller = createController({ maxValueBytes: 4, maxKeyBytes: 4 })
    const valueCache = new Map<string, string>()
    const keyCache = new Map<string, string>()

    expect(controller.set(valueCache, 'v', '1234')).toBe(true)
    expect(controller.set(keyCache, '1234', 'v')).toBe(true)
    expect(controller.get(valueCache, 'v')).toBe('1234')
    expect(controller.get(keyCache, '1234')).toBe('v')
  })

  it('rejects a key or value one byte over its limit', () => {
    const controller = createController({ maxValueBytes: 4, maxKeyBytes: 4 })
    const cache = new Map<string, string>()

    expect(controller.set(cache, '12345', 'v')).toBe(false)
    expect(controller.set(cache, 'v', '12345')).toBe(false)
    expect(cache.size).toBe(0)
    expect(controller.getRetainedBytes()).toBe(0)
  })

  it('measures multibyte scope keys as UTF-8', () => {
    const controller = createController({ maxKeyBytes: 4 })
    const cache = new Map<string, string>()

    expect(controller.set(cache, '😀', 'exact')).toBe(true)
    expect(controller.set(cache, '😀a', 'too large')).toBe(false)
    expect(cache.has('😀')).toBe(true)
    expect(cache.has('😀a')).toBe(false)
  })

  it('retains an entry exactly at the aggregate limit', () => {
    const controller = createController({
      maxAggregateBytes: 5,
      maxValueBytes: 5,
      maxKeyBytes: 1
    })
    const cache = new Map<string, string>()

    expect(controller.set(cache, 'k', '1234')).toBe(true)
    expect(controller.getRetainedBytes()).toBe(5)
    expect(controller.get(cache, 'k')).toBe('1234')
  })

  it('rejects one entry larger than the aggregate limit', () => {
    const controller = createController({
      maxAggregateBytes: 5,
      maxValueBytes: 5,
      maxKeyBytes: 1
    })
    const cache = new Map<string, string>()

    expect(controller.set(cache, 'k', '12345')).toBe(false)
    expect(cache.size).toBe(0)
  })

  it('globally evicts the least-recently-used entry across caches', () => {
    const controller = createController({
      maxAggregateBytes: 10,
      maxValueBytes: 4,
      maxKeyBytes: 1
    })
    const first = new Map<string, string>()
    const second = new Map<string, string>()
    const third = new Map<string, string>()

    controller.set(first, 'a', '1111')
    controller.set(second, 'b', '2222')
    controller.set(third, 'c', '3333')

    expect(first.has('a')).toBe(false)
    expect(second.get('b')).toBe('2222')
    expect(third.get('c')).toBe('3333')
    expect(controller.getRetainedBytes()).toBe(10)
  })

  it('refreshes global LRU order when an entry is read', () => {
    const controller = createController({
      maxAggregateBytes: 10,
      maxValueBytes: 4,
      maxKeyBytes: 1
    })
    const first = new Map<string, string>()
    const second = new Map<string, string>()
    const third = new Map<string, string>()

    controller.set(first, 'a', '1111')
    controller.set(second, 'b', '2222')
    expect(controller.get(first, 'a')).toBe('1111')
    controller.set(third, 'c', '3333')

    expect(first.get('a')).toBe('1111')
    expect(second.has('b')).toBe(false)
    expect(third.get('c')).toBe('3333')
  })

  it('releases retained-byte accounting on delete and clear', () => {
    const controller = createController()
    const first = new Map<string, string>()
    const second = new Map<string, string>()

    controller.set(first, 'a', '111')
    controller.set(first, 'b', '22')
    controller.set(second, 'c', '3')
    expect(controller.getRetainedBytes()).toBe(9)

    controller.delete(first, 'a')
    expect(controller.getRetainedBytes()).toBe(5)
    controller.clear(first)
    expect(controller.getRetainedBytes()).toBe(2)
    controller.clear(second)
    expect(controller.getRetainedBytes()).toBe(0)
  })

  it('removes a stale value when an update is inadmissible', () => {
    const controller = createController({ maxValueBytes: 4 })
    const cache = new Map<string, string>()

    controller.set(cache, 'key', 'old')
    expect(controller.set(cache, 'key', '12345')).toBe(false)

    expect(controller.get(cache, 'key')).toBeUndefined()
    expect(controller.getRetainedBytes()).toBe(0)
  })

  it('measures nested values without looping on repeated references', () => {
    const controller = createController({ maxValueBytes: 64 })
    const cache = new Map<string, unknown>()
    const value: { label: string; self?: unknown } = { label: 'cycle' }
    value.self = value

    expect(controller.set(cache, 'key', value)).toBe(true)
    expect(controller.get(cache, 'key')).toBe(value)
  })

  it('preserves the 128-entry per-cache cap', () => {
    const controller = createNativeChatScopeCacheController()
    const cache = new Map<string, number>()

    controller.set(cache, 'keep', 1)
    const total = NATIVE_CHAT_COMPOSER_SCOPE_CACHE_MAX + 20
    for (let index = 0; index < total; index += 1) {
      controller.set(cache, `scope-${index}`, index)
      if (index % 10 === 0) {
        controller.set(cache, 'keep', 1)
      }
    }

    expect(cache.size).toBe(NATIVE_CHAT_COMPOSER_SCOPE_CACHE_MAX)
    expect(cache.has('scope-0')).toBe(false)
    expect(cache.has('keep')).toBe(true)
    expect(cache.has(`scope-${total - 1}`)).toBe(true)
  })
})
