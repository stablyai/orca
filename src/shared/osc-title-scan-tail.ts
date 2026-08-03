import { detachString, EMPTY_DETACHED_STRING, type DetachedString } from './detached-string'

const OSC_TITLE_SCAN_TAIL_LIMIT = 4096
const OSC_TITLE_PREFIX_LENGTH = 4
const OSC_TITLE_CODES = new Set(['0', '1', '2'])
const LONE_ESC_TAIL = detachString('\x1b')

// Persisted per-PTY tails must not retain their source chunks.
export function extractOscTitleScanTail(input: string): DetachedString {
  const lastOsc = input.lastIndexOf('\x1b]')
  if (lastOsc !== -1) {
    const suffix = input.slice(lastOsc)
    if (!suffix.includes('\x07') && !suffix.includes('\x1b\\')) {
      return extractIncompleteTitleOscTail(suffix)
    }
    return input.endsWith('\x1b') ? LONE_ESC_TAIL : EMPTY_DETACHED_STRING
  }
  return input.endsWith('\x1b') ? LONE_ESC_TAIL : EMPTY_DETACHED_STRING
}

function extractIncompleteTitleOscTail(suffix: string): DetachedString {
  const parameterEnd = suffix.indexOf(';', 2)
  if (parameterEnd === -1) {
    const partialParameter = suffix.slice(2)
    return ['', '0', '1', '2'].includes(partialParameter)
      ? trimOscTitleScanTail(suffix)
      : EMPTY_DETACHED_STRING
  }
  const parameter = suffix.slice(2, parameterEnd)
  return OSC_TITLE_CODES.has(parameter) ? trimOscTitleScanTail(suffix) : EMPTY_DETACHED_STRING
}

function trimOscTitleScanTail(value: string): DetachedString {
  if (value.length <= OSC_TITLE_SCAN_TAIL_LIMIT) {
    return detachString(value)
  }
  // Preserve the OSC introducer while keeping the newest payload bytes, so
  // bounded tails can still reconstruct a split title terminator.
  const prefix = value.slice(0, Math.min(OSC_TITLE_PREFIX_LENGTH, value.length))
  const suffixBudget = Math.max(0, OSC_TITLE_SCAN_TAIL_LIMIT - prefix.length)
  return detachString(`${prefix}${value.slice(-suffixBudget)}`)
}
