const OSC_TITLE_SCAN_TAIL_LIMIT = 4096
const OSC_TITLE_PREFIX_LENGTH = 4

export function extractOscTitleScanTail(input: string): string {
  const lastOsc = input.lastIndexOf('\x1b]')
  if (lastOsc !== -1) {
    const suffix = input.slice(lastOsc)
    if (!suffix.includes('\x07') && !suffix.includes('\x1b\\')) {
      return trimOscTitleScanTail(suffix)
    }
    return input.endsWith('\x1b') ? '\x1b' : ''
  }
  return input.endsWith('\x1b') ? '\x1b' : ''
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
