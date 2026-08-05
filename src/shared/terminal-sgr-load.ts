const TERMINAL_SGR_CLASSIFICATION_MAX_CHARS = 16 * 1024

export function isDenseTerminalSgr(data: string): boolean {
  let sgrSequences = 0
  let textChars = 0
  const limit = Math.min(data.length, TERMINAL_SGR_CLASSIFICATION_MAX_CHARS)

  for (let index = 0; index < limit; index += 1) {
    if (data[index] !== '\x1b' || data[index + 1] !== '[') {
      textChars += 1
      continue
    }

    let cursor = index + 2
    let terminated = false
    while (cursor < limit) {
      const code = data.charCodeAt(cursor)
      if (code >= 0x40 && code <= 0x7e) {
        if (data[cursor] === 'm') {
          sgrSequences += 1
        }
        index = cursor
        terminated = true
        break
      }
      cursor += 1
    }
    if (!terminated) {
      break
    }
  }

  return sgrSequences >= 32 && sgrSequences * 2 >= textChars
}

export function stripTerminalSgr(data: string): string {
  let output = ''
  let copyFrom = 0

  for (let index = 0; index < data.length; index += 1) {
    if (data[index] !== '\x1b' || data[index + 1] !== '[') {
      continue
    }
    let cursor = index + 2
    let terminated = false
    while (cursor < data.length) {
      const code = data.charCodeAt(cursor)
      if (code >= 0x40 && code <= 0x7e) {
        if (data[cursor] === 'm') {
          output += data.slice(copyFrom, index)
          copyFrom = cursor + 1
        }
        index = cursor
        terminated = true
        break
      }
      cursor += 1
    }
    if (!terminated) {
      break
    }
  }

  // Boundary CAN/reset prevents carried parser or style state from swallowing retained bytes.
  return `\x18\x1b[0m${output}${data.slice(copyFrom)}\x18\x1b[0m`
}
