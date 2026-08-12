export function* iterateNulDelimitedFields(value: string): Generator<string> {
  let start = 0
  while (start <= value.length) {
    const end = value.indexOf('\0', start)
    if (end === -1) {
      yield value.slice(start)
      return
    }
    yield value.slice(start, end)
    start = end + 1
  }
}
