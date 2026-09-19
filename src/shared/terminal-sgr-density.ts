/**
 * Returns true for output whose SGR controls are dense enough to make xterm
 * parsing substantially more expensive than the equivalent plain text.
 */
export function isDenseSgr(data: string): boolean {
  if (!data.includes('\x1b')) {
    return false
  }
  let sgrCount = 0
  let textCount = 0
  let index = 0

  while (index < data.length) {
    if (data.charCodeAt(index) === 0x1b && data[index + 1] === '[') {
      let cursor = index + 2
      while (cursor < data.length && !(data[cursor] >= '@' && data[cursor] <= '~')) {
        cursor += 1
      }
      if (cursor < data.length && data[cursor] === 'm') {
        sgrCount += 1
      }
      index = cursor < data.length ? cursor + 1 : data.length
      continue
    }
    textCount += 1
    index += 1
  }

  return textCount > 0 && sgrCount * 2 >= textCount
}
