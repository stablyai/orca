import type { NativeChatMessage } from './native-chat-types'

type Fields = Readonly<Record<string, unknown>>

function isFields(value: unknown): value is Fields {
  return typeof value === 'object' && value !== null
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

/** Whether a re-derived message carries the same values as `prior`, down to each block's fields. */
export function sameNativeChatMessage(prior: NativeChatMessage, next: NativeChatMessage): boolean {
  return sameValues(prior, next, MESSAGE_DEPTH)
}

/** Transcript rows by message id, compared down to each block's fields. */
export function createNativeChatMessageReuse(): (
  messages: NativeChatMessage[]
) => NativeChatMessage[] {
  const reuse = createNativeChatRowReuse<NativeChatMessage>(MESSAGE_DEPTH)
  return (messages) => reuse(messages, (index) => messages[index]!.id)
}
