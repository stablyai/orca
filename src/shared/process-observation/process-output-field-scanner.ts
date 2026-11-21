export const PROCESS_OUTPUT_FIELD_SCAN_MAX_CHARS = 4096

// Why: process output can be multi-MB; callers should not materialize every line up front.
export function* iterateProcessOutputLines(output: string): Generator<string> {
  let lineStart = 0

  for (let index = 0; index < output.length; index += 1) {
    const code = output.charCodeAt(index)
    if (code !== 10 && code !== 13) {
      continue
    }

    yield output.slice(lineStart, index)
    if (code === 13 && output.charCodeAt(index + 1) === 10) {
      index += 1
    }
    lineStart = index + 1
  }

  if (lineStart < output.length) {
    yield output.slice(lineStart)
  }
}

// Why: command output can include noisy paste-sized rows; port scanners only need early fields.
export function getProcessOutputFields(line: string, maxFields: number): string[] {
  if (maxFields <= 0) {
    return []
  }

  const fields: string[] = []
  const scanLimit = Math.min(line.length, PROCESS_OUTPUT_FIELD_SCAN_MAX_CHARS)
  let tokenStart = -1

  for (let index = 0; index <= scanLimit; index += 1) {
    const isEnd = index === scanLimit
    if (!isEnd && !isProcessOutputWhitespace(line.charCodeAt(index))) {
      if (tokenStart === -1) {
        tokenStart = index
      }
      continue
    }

    if (tokenStart === -1) {
      continue
    }

    fields.push(line.slice(tokenStart, index))
    tokenStart = -1
    if (fields.length >= maxFields) {
      break
    }
  }

  return fields
}

function isProcessOutputWhitespace(code: number): boolean {
  return (
    code === 32 ||
    (code >= 9 && code <= 13) ||
    code === 160 ||
    code === 5760 ||
    (code >= 8192 && code <= 8202) ||
    code === 8232 ||
    code === 8233 ||
    code === 8239 ||
    code === 8287 ||
    code === 12288 ||
    code === 65279
  )
}
