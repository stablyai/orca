import { vi } from 'vitest'

/** Observe real record reads and native array movement, including reference-only indexOf/splice work. */
export function observeRetainedInputWork() {
  const iterator = Array.prototype[Symbol.iterator]
  const push = Array.prototype.push
  const slice = Array.prototype.slice
  const splice = Array.prototype.splice
  const shift = Array.prototype.shift
  const indexOf = Array.prototype.indexOf
  const observed = new WeakSet<object>()
  let counting = false
  let reads = 0
  let visits = 0
  let searches = 0
  let copies = 0
  const record = (value: unknown): value is object =>
    value !== null &&
    typeof value === 'object' &&
    (('seq' in value && 'text' in value && !('target' in value)) ||
      ('data' in value && 'kind' in value && 'inputKind' in value))
  const observe = (value: unknown): void => {
    if (!record(value) || observed.has(value)) {
      return
    }
    observed.add(value)
    for (const key of Object.keys(value)) {
      const descriptor = Object.getOwnPropertyDescriptor(value, key)
      if (!descriptor || !('value' in descriptor) || !descriptor.configurable) {
        continue
      }
      let field: unknown = descriptor.value
      Object.defineProperty(value, key, {
        configurable: true,
        enumerable: descriptor.enumerable,
        get: () => {
          reads += Number(counting)
          return field
        },
        set: (next: unknown) => {
          field = next
        }
      })
    }
  }
  const isRecords = (array: unknown[]): boolean => array.length > 0 && record(array[0])
  const pushSpy = vi.spyOn(Array.prototype, 'push').mockImplementation(function (
    this: unknown[],
    ...items: unknown[]
  ) {
    for (const item of items) {
      observe(item)
    }
    if (counting && isRecords(items)) {
      copies += items.length
    }
    return push.apply(this, items)
  })
  const iteratorSpy = vi.spyOn(Array.prototype, Symbol.iterator).mockImplementation(function* (
    this: unknown[]
  ) {
    const current = iterator.call(this)
    for (let step = current.next(); !step.done; step = current.next()) {
      observe(step.value)
      if (counting && record(step.value)) {
        visits += 1
      }
      yield step.value
    }
  })
  const sliceSpy = vi.spyOn(Array.prototype, 'slice').mockImplementation(function (
    this: unknown[],
    start?: number,
    end?: number
  ) {
    const result = slice.call(this, start, end)
    if (counting && isRecords(this)) {
      copies += result.length
    }
    return result
  })
  const indexSpy = vi.spyOn(Array.prototype, 'indexOf').mockImplementation(function (
    this: unknown[],
    value: unknown,
    from = 0
  ) {
    const result = indexOf.call(this, value, from)
    if (counting && isRecords(this)) {
      const offset = from < 0 ? Math.max(0, this.length + from) : from
      searches += Math.max(0, (result < 0 ? this.length : result + 1) - offset)
    }
    return result
  })
  const shiftSpy = vi.spyOn(Array.prototype, 'shift').mockImplementation(function (
    this: unknown[]
  ) {
    if (counting && isRecords(this)) {
      copies += 1 + 2 * (this.length - 1)
    }
    return shift.call(this)
  })
  const spliceSpy = vi.spyOn(Array.prototype, 'splice').mockImplementation(function (
    this: unknown[],
    ...args: [start: number, deleteCount?: number, ...items: unknown[]]
  ) {
    const [start, deleteCount, ...items] = args
    if (counting && isRecords(this)) {
      const offset = start < 0 ? Math.max(0, this.length + start) : Math.min(start, this.length)
      const removed =
        args.length === 1
          ? this.length - offset
          : Math.min(Math.max(0, deleteCount ?? 0), this.length - offset)
      copies += removed + (removed === items.length ? 0 : 2 * (this.length - offset - removed))
    }
    return Reflect.apply(splice, this, args)
  })
  return {
    measure: (operation: () => void) => {
      reads = visits = searches = copies = 0
      counting = true
      try {
        operation()
      } finally {
        counting = false
      }
      return { reads, visits, searches, copies, total: reads + visits + searches + copies }
    },
    dispose: () => {
      spliceSpy.mockRestore()
      shiftSpy.mockRestore()
      indexSpy.mockRestore()
      sliceSpy.mockRestore()
      iteratorSpy.mockRestore()
      pushSpy.mockRestore()
    }
  }
}
