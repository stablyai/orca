import type { NativeChatMessage } from './native-chat-types'

type Fields = Readonly<Record<string, unknown>>

// Why: only plain objects and arrays compare by value; a Set, Map or class instance keeps its
// state off its own keys, so two with different contents would otherwise read as equal.
function isFields(value: unknown): value is Fields {
  if (typeof value !== 'object' || value === null) {
    return false
  }
  const proto: unknown = Object.getPrototypeOf(value)
  return Array.isArray(value) || proto === Object.prototype || proto === null
}

/** Same values `depth` objects down, identity below: re-deriving a row rebuilds its
 *  containers (a folded run's block list, an image turn's blocks) around unchanged values. */
function sameValues(left: Fields, right: Fields, depth: number): boolean {
  if (left === right) {
    return true
  }
  // Folding rebuilds block lists every batch; an index loop skips Object.keys' allocations.
  if (Array.isArray(left) && Array.isArray(right)) {
    if (left.length !== right.length) {
      return false
    }
    for (let index = 0; index < left.length; index++) {
      if (!sameValue(left[index], right[index], depth)) {
        return false
      }
    }
    return true
  }
  const keys = Object.keys(left)
  return (
    keys.length === Object.keys(right).length &&
    keys.every((key) => Object.hasOwn(right, key) && sameValue(left[key], right[key], depth))
  )
}

function sameValue(a: unknown, b: unknown, depth: number): boolean {
  return a === b || (depth > 0 && isFields(a) && isFields(b) && sameValues(a, b, depth - 1))
}

/** Hands back the previous call's row for every id whose values are unchanged, and the
 *  previous array when every row's are, so memoized renderers skip what a batch left alone. */
export function createNativeChatRowReuse<Row extends Fields>(
  depth: number
): (rows: Row[], idOf: (index: number) => string) => Row[] {
  let previous: Row[] = []
  let byId = new Map<string, Row>()
  return (rows, idOf) => {
    const next = rows.map((row, index) => {
      const prior = byId.get(idOf(index))
      return prior && sameValues(prior, row, depth) ? prior : row
    })
    if (next.length === previous.length && next.every((row, index) => row === previous[index])) {
      return previous
    }
    previous = next
    byId = new Map(next.map((row, index) => [idOf(index), row]))
    return next
  }
}

// A message, its block list, then each block's fields: folding rebuilds the first two.
const MESSAGE_DEPTH = 2

/** Transcript rows by message id, compared down to each block's fields. */
export function createNativeChatMessageReuse(): (
  messages: NativeChatMessage[]
) => NativeChatMessage[] {
  const reuse = createNativeChatRowReuse<NativeChatMessage>(MESSAGE_DEPTH)
  return (messages) => reuse(messages, (index) => messages[index]!.id)
}
