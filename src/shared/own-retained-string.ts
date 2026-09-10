import { copyUtf16SuffixToOwnedString } from './owned-utf16-suffix'

// V8 SlicedString::kMinLength. Shorter slices are already flat, so copying them is pure waste.
const MIN_SLICED_STRING_LENGTH = 13

/** Lone surrogates and an unpaired trail must survive the round trip byte-for-byte. */
const ROUND_TRIP_PROBE = '\ud800a\udfff\u0000\u6f22'

let copyString: ((value: string) => string) | null = null

function detectBufferCopier(): ((value: string) => string) | null {
  const buffer = (globalThis as { Buffer?: typeof Buffer }).Buffer
  if (typeof buffer?.from !== 'function') {
    return null
  }
  try {
    if (buffer.from(ROUND_TRIP_PROBE, 'utf16le').toString('utf16le') !== ROUND_TRIP_PROBE) {
      return null
    }
  } catch {
    return null
  }
  return (value) => buffer.from(value, 'utf16le').toString('utf16le')
}

function resolveCopyString(): (value: string) => string {
  if (!copyString) {
    // Buffer is absent in the renderer and on mobile; fall back to the code-unit block copier.
    copyString =
      detectBufferCopier() ?? ((value: string) => copyUtf16SuffixToOwnedString(value, value.length))
  }
  return copyString
}

/**
 * Return a standalone copy of a string that outlives the chunk it came from.
 * Why: `bigChunk.slice(a, b)` is a V8 SlicedString that pins the whole parent,
 * so retaining a few KiB of tail can pin megabytes of already-consumed output.
 */
export function ownRetainedString(value: string): string {
  if (value.length < MIN_SLICED_STRING_LENGTH) {
    return value
  }
  return resolveCopyString()(value)
}

/** Test-only: drop the memoized copier so a fallback path can be exercised. */
export function resetOwnRetainedStringCopier(): void {
  copyString = null
}
