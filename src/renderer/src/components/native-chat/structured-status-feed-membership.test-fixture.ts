import { act } from '@testing-library/react'
import { vi } from 'vitest'

// Observe actual collection work without replacing the private members or groups.
export function measureMembership(trigger: () => void) {
  const work = { members: 0, groups: 0 }
  function observe<T>(iterator: MapIterator<T>): MapIterator<T> {
    const next = iterator.next.bind(iterator)
    iterator.next = () => {
      const item = next()
      const value: unknown = Array.isArray(item.value) ? item.value[1] : item.value
      if (!item.done && value && typeof value === 'object') {
        if ('paneKey' in value && 'group' in value && 'tab' in value) {
          work.members += 1
        }
        if ('feed' in value && 'unsubscribe' in value) {
          work.groups += 1
        }
      }
      return item
    }
    return iterator
  }
  const values = Map.prototype.values
  const entries = Map.prototype[Symbol.iterator]
  const spies = [
    vi.spyOn(Map.prototype, 'values').mockImplementation(function (this: Map<unknown, unknown>) {
      return observe(values.call(this))
    }),
    vi.spyOn(Map.prototype, Symbol.iterator).mockImplementation(function (
      this: Map<unknown, unknown>
    ) {
      return observe(entries.call(this))
    })
  ]
  try {
    act(trigger)
    return work
  } finally {
    for (const spy of spies) {
      spy.mockRestore()
    }
  }
}
