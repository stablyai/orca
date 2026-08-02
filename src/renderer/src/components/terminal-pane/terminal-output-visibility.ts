// Why: attach-time clear is only safe before bytes that draw a replacement
// frame; metadata/control-only replay must preserve restored scrollback.
export function hasTerminalDisplayContent(chunk: string): boolean {
  for (let index = 0; index < chunk.length; index += 1) {
    const code = chunk.charCodeAt(index)
    const control = parseTerminalControlSequence(chunk, index)
    if (control !== undefined) {
      if (control === null) {
        return false
      }
      if (control.affectsDisplay) {
        return true
      }
      index = control.end
      continue
    }
    if (isIgnoredControlCode(code)) {
      continue
    }
    if (isDisplayAffectingControlCode(code) || (code >= 0x20 && code !== 0x7f)) {
      return true
    }
  }

  return false
}

export function trimIncompleteTerminalControlTail(chunk: string): string {
  for (let index = 0; index < chunk.length; index += 1) {
    const control = parseTerminalControlSequence(chunk, index)
    if (control === undefined) {
      continue
    }
    if (control === null) {
      return chunk.slice(0, index)
    }
    index = control.end
  }

  return chunk
}

type ParsedTerminalControlSequence = {
  end: number
  affectsDisplay: boolean
}

function parseTerminalControlSequence(
  value: string,
  index: number
): ParsedTerminalControlSequence | null | undefined {
  const code = value.charCodeAt(index)
  if (code === 0x1b) {
    return parseEscControlSequence(value, index)
  }
  if (code === 0x9b) {
    return parseCsiSequence(value, index + 1)
  }
  if (code === 0x9d) {
    return parseStringControlSequence(value, index + 1, { affectsDisplay: false })
  }
  if (code === 0x90 || code === 0x98 || code === 0x9e || code === 0x9f) {
    return parseStringControlSequence(value, index + 1, {
      affectsDisplay: false,
      belTerminates: false
    })
  }
  return undefined
}

function parseEscControlSequence(
  value: string,
  escapeIndex: number
): ParsedTerminalControlSequence | null {
  const introducer = value[escapeIndex + 1]
  if (!introducer) {
    return null
  }
  if (introducer === '[') {
    return parseCsiSequence(value, escapeIndex + 2)
  }
  if (introducer === ']') {
    return parseStringControlSequence(value, escapeIndex + 2, { affectsDisplay: false })
  }
  if (isStTerminatedStringControlIntroducer(introducer)) {
    return parseStringControlSequence(value, escapeIndex + 2, {
      affectsDisplay: false,
      belTerminates: false
    })
  }
  if (introducer === '#') {
    return value.length > escapeIndex + 2 ? { end: escapeIndex + 2, affectsDisplay: true } : null
  }
  if (isEscIntermediateIntroducer(introducer)) {
    return value.length > escapeIndex + 2 ? { end: escapeIndex + 2, affectsDisplay: false } : null
  }
  return { end: escapeIndex + 1, affectsDisplay: true }
}

function parseCsiSequence(value: string, startIndex: number): ParsedTerminalControlSequence | null {
  for (let index = startIndex; index < value.length; index += 1) {
    const code = value.charCodeAt(index)
    if (code >= 0x40 && code <= 0x7e) {
      return {
        end: index,
        affectsDisplay: csiSequenceAffectsDisplay(value.slice(startIndex, index), value[index])
      }
    }
  }
  return null
}

function parseStringControlSequence(
  value: string,
  startIndex: number,
  options: { affectsDisplay: boolean; belTerminates?: boolean }
): ParsedTerminalControlSequence | null {
  const belTerminates = options.belTerminates !== false
  for (let index = startIndex; index < value.length; index += 1) {
    if (belTerminates && value[index] === '\u0007') {
      return { end: index, affectsDisplay: options.affectsDisplay }
    }
    if (value[index] === '\u001b' && value[index + 1] === '\\') {
      return { end: index + 1, affectsDisplay: options.affectsDisplay }
    }
    if (value.charCodeAt(index) === 0x9c) {
      return { end: index, affectsDisplay: options.affectsDisplay }
    }
  }
  return null
}

function csiSequenceAffectsDisplay(parametersAndIntermediates: string, final: string): boolean {
  if (final === 'm') {
    return false
  }
  if (final === 'q' && parametersAndIntermediates.includes(' ')) {
    return false
  }
  if (final === 'h' || final === 'l') {
    return csiModeSequenceAffectsDisplay(parametersAndIntermediates)
  }
  return true
}

function csiModeSequenceAffectsDisplay(parametersAndIntermediates: string): boolean {
  const modeNumbers = parametersAndIntermediates.match(/\d+/g) ?? []
  return modeNumbers.some((mode) => mode === '47' || mode === '1047' || mode === '1049')
}

function isIgnoredControlCode(code: number): boolean {
  return code === 0x7f || code < 0x08 || (code > 0x0d && code < 0x20)
}

function isDisplayAffectingControlCode(code: number): boolean {
  return (code >= 0x08 && code <= 0x0d) || code === 0x84 || code === 0x85 || code === 0x8d
}

function isStTerminatedStringControlIntroducer(introducer: string): boolean {
  return introducer === 'P' || introducer === 'X' || introducer === '^' || introducer === '_'
}

function isEscIntermediateIntroducer(introducer: string): boolean {
  const code = introducer.charCodeAt(0)
  return code >= 0x20 && code <= 0x2f
}
