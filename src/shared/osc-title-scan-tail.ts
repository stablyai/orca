const OSC_TITLE_SCAN_TAIL_LIMIT = 4096
const OSC_TITLE_PREFIX_LENGTH = 4
const OSC_TITLE_CODES = new Set(['0', '1', '2'])

export function extractOscTitleScanTail(input: string): string {
  const lastOsc = input.lastIndexOf('\x1b]')
  if (lastOsc !== -1) {
    const suffix = input.slice(lastOsc)
    if (!suffix.includes('\x07') && !suffix.includes('\x1b\\')) {
      return extractIncompleteTitleOscTail(suffix)
    }
    return input.endsWith('\x1b') ? '\x1b' : ''
  }
  return input.endsWith('\x1b') ? '\x1b' : ''
}

function extractIncompleteTitleOscTail(suffix: string): string {
  const parameterEnd = suffix.indexOf(';', 2)
  if (parameterEnd === -1) {
    const partialParameter = suffix.slice(2)
    return ['', '0', '1', '2'].includes(partialParameter) ? trimOscTitleScanTail(suffix) : ''
  }
  const parameter = suffix.slice(2, parameterEnd)
  return OSC_TITLE_CODES.has(parameter) ? trimOscTitleScanTail(suffix) : ''
}

function trimOscTitleScanTail(value: string): string {
  if (value.length <= OSC_TITLE_SCAN_TAIL_LIMIT) {
    return value
  }
  // Preserve the OSC introducer while keeping the newest payload bytes, so
  // bounded tails can still reconstruct a split title terminator.
  const prefix = value.slice(0, Math.min(OSC_TITLE_PREFIX_LENGTH, value.length))
  const suffixBudget = Math.max(0, OSC_TITLE_SCAN_TAIL_LIMIT - prefix.length)
  return `${prefix}${value.slice(-suffixBudget)}`
}
