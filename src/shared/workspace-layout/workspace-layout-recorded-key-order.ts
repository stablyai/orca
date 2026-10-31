export function compareRecordedKeys(left: string, right: string): number {
  for (let i = 0; i < Math.min(left.length, right.length); i++) {
    const difference = left.charCodeAt(i) - right.charCodeAt(i)
    if (difference !== 0) {
      return difference
    }
  }
  return left.length - right.length
}

export function sortRecordedKeys(keys: string[]): string[] {
  let output = keys.slice()
  for (let width = 1; width < keys.length; width *= 2) {
    for (let start = 0; start < keys.length; start += width * 2) {
      const middle = Math.min(start + width, keys.length)
      const end = Math.min(start + width * 2, keys.length)
      let left = start
      let right = middle
      for (let next = start; next < end; next++) {
        output[next] =
          left < middle && (right >= end || compareRecordedKeys(keys[left], keys[right]) <= 0)
            ? keys[left++]
            : keys[right++]
      }
    }
    const previous = keys
    keys = output
    output = previous
  }
  return keys
}
