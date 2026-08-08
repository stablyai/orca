/**
 * Dense-SGR probe shared by the main delivery gate and the renderer scheduler
 * so both drop/freeze decisions use the SAME threshold.
 */
export function isDenseSgr(data: string): boolean {
  let sgrCount = 0
  let charCount = 0
  let index = 0
  const length = data.length
  while (index < length) {
    if (data.charCodeAt(index) === 0x1b && data[index + 1] === '[') {
      let cursor = index + 2
      while (cursor < length && !(data[cursor] >= '@' && data[cursor] <= '~')) {
        cursor += 1
      }
      if (cursor < length && data[cursor] === 'm') {
        sgrCount += 1
      }
      index = cursor < length ? cursor + 1 : length
    } else {
      charCount += 1
      index += 1
    }
  }
  // Use one SGR per two non-CSI characters as the dense-output threshold.
  return charCount > 0 && sgrCount * 2 >= charCount
}
