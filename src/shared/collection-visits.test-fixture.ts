type Method = (...args: unknown[]) => unknown
type Tally = { visits: number; lookups: number }
/** The built-in prototypes whose methods are patched. */
type CollectionPrototype = unknown[] | Map<unknown, unknown> | Set<unknown>
// What every built-in iterator inherits, so a counted one keeps the iterator helpers.
const iteratorPrototype: object = Object.getPrototypeOf(Object.getPrototypeOf([].values()))
// Open measurements, innermost last; only the innermost counts, so a nested one is kept apart.
const open: Tally[] = []
let restore: (() => void) | null = null
// Work while the patches go on or off belongs to no measurement.
const visit = (count = 1) => {
  const tally = open.at(-1)
  if (tally) {
    tally.visits += count
  }
}

/** Every array, map and set element `run` visits while it runs synchronously, through iteration
 *  or a search, filter or callback method, and every map or set key it looks up. Work inside a
 *  nested call is that call's alone. Test-only: built-in prototypes are patched meanwhile. */
export function collectionVisits<T>(run: () => T): { value: T } & Tally {
  const tally = { visits: 0, lookups: 0 }
  restore ??= patchCollections()
  open.push(tally)
  try {
    return { value: run(), ...tally }
  } finally {
    open.pop()
    if (open.length === 0) {
      restore()
      restore = null
    }
  }
}

const isMethod = (value: unknown): value is Method => typeof value === 'function'
const isIterator = (value: unknown): value is Iterator<unknown> =>
  typeof value === 'object' && value !== null && 'next' in value && isMethod(value.next)

function patchCollections(): () => void {
  const originals: [CollectionPrototype, PropertyKey, PropertyDescriptor][] = []
  // Through descriptors: the built-in method is replaced as it was defined, and put back the same.
  const replace = (
    target: CollectionPrototype,
    key: PropertyKey,
    wrap: (original: Method) => Method
  ) => {
    const descriptor = Object.getOwnPropertyDescriptor(target, key)
    const original: unknown = descriptor?.value
    if (!descriptor || !isMethod(original)) {
      throw new TypeError(`collectionVisits: no built-in method ${String(key)}`)
    }
    originals.push([target, key, descriptor])
    Object.defineProperty(target, key, { ...descriptor, value: wrap(original) })
  }
  const counting = (original: Method) =>
    function (this: unknown) {
      // `arguments`, not a rest parameter: that would iterate an array and count itself.
      const iterator: unknown = Reflect.apply(original, this, arguments)
      if (!isIterator(iterator)) {
        return iterator
      }
      return Object.assign(Object.create(iteratorPrototype), {
        next: () => {
          const step = iterator.next()
          visit(step.done ? 0 : 1)
          return step
        }
      })
    }
  for (const proto of [Array.prototype, Map.prototype, Set.prototype]) {
    for (const key of [Symbol.iterator, 'entries', 'values', 'keys']) {
      replace(proto, key, counting)
    }
  }
  const callbacks = ['filter', 'some', 'every', 'find', 'findIndex', 'map', 'flatMap', 'forEach']
  for (const [proto, keys] of [
    [Array.prototype, callbacks],
    [Map.prototype, ['forEach']],
    [Set.prototype, ['forEach']]
  ] as const) {
    for (const key of keys) {
      replace(
        proto,
        key,
        (original) =>
          // No spread or rest here: either would iterate an array and count itself.
          function (this: unknown, callback: unknown, thisArg: unknown) {
            // A callback that is not one fails in the built-in itself, uncounted.
            if (!isMethod(callback)) {
              return original.call(this, callback, thisArg)
            }
            return original.call(
              this,
              function (this: unknown) {
                visit()
                return Reflect.apply(callback, this, arguments)
              },
              thisArg
            )
          }
      )
    }
  }
  const indexOf = Array.prototype.indexOf
  for (const key of ['indexOf', 'includes']) {
    replace(
      Array.prototype,
      key,
      (original) =>
        function (this: unknown[], search: unknown, from: unknown) {
          const at: number = Reflect.apply(indexOf, this, arguments)
          visit(at === -1 ? this.length : at + 1)
          return original.call(this, search, from)
        }
    )
  }
  for (const proto of [Map.prototype, Set.prototype]) {
    for (const key of proto === Map.prototype ? ['get', 'has'] : ['has']) {
      replace(
        proto,
        key,
        (original) =>
          function (this: unknown, item: unknown) {
            const tally = open.at(-1)
            if (tally) {
              tally.lookups++
            }
            return original.call(this, item)
          }
      )
    }
  }
  return () => {
    for (const [proto, key, descriptor] of originals.toReversed()) {
      Object.defineProperty(proto, key, descriptor)
    }
  }
}

type Fields = Record<string, unknown>
type LayoutNode =
  | { type: 'leaf'; groupId: string }
  | { type: 'split'; first: LayoutNode; second: LayoutNode }

/** Reads of chosen fields of real objects, counted in place: each field is an accessor until
 *  `restore`, then a plain field with its value again, so every value keeps its identity. */
export function fieldReads() {
  let reads = 0
  const watched = new WeakSet<Fields>()
  const undo: (() => void)[] = []
  const watch = (target: Fields, keys: readonly string[] = Object.keys(target)) => {
    if (watched.has(target)) {
      return
    }
    watched.add(target)
    for (const key of keys) {
      const value = target[key]
      Object.defineProperty(target, key, {
        configurable: true,
        enumerable: true,
        get: () => {
          reads++
          return value
        }
      })
      undo.push(() =>
        Object.defineProperty(target, key, {
          configurable: true,
          enumerable: true,
          writable: true,
          value
        })
      )
    }
  }
  /** Watches every node of a group tree, and says how many it has. */
  const watchTree = (node: LayoutNode | undefined): number => {
    if (!node) {
      return 0
    }
    const children = node.type === 'split' ? [node.first, node.second] : []
    watch(node)
    return 1 + children.reduce((sum, child) => sum + watchTree(child), 0)
  }
  return {
    watch,
    watchTree,
    reads: () => reads,
    restore: () => {
      for (const step of undo.toReversed()) {
        step()
      }
      undo.length = 0
    }
  }
}
