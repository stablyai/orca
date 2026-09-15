import { getSeparator } from '@/lib/path'

const ELLIPSIS_PREFIX = '…'

/** Measures rendered width of a candidate string in the element's own font. */
export type PathWidthMeasurer = (candidate: string) => number

/**
 * Drops leading path segments until the label fits `availableWidth`, so the
 * deepest folders and the file name stay visible. The last segment is never
 * dropped; when it alone overflows, it is returned for CSS ellipsis to trim.
 */
export function ellipsizePathStart(
  label: string,
  availableWidth: number,
  measure: PathWidthMeasurer
): string {
  if (!label || availableWidth <= 0) {
    return label
  }

  if (measure(label) <= availableWidth) {
    return label
  }

  const separator = getSeparator(label)
  const segments = label.split(/[\\/]/)
  if (segments.length <= 1) {
    return label
  }

  // Index 0 is the root-anchoring empty segment or drive letter; the ellipsis
  // replaces it and every segment dropped after it.
  for (let firstKept = 1; firstKept < segments.length; firstKept += 1) {
    const candidate = `${ELLIPSIS_PREFIX}${separator}${segments.slice(firstKept).join(separator)}`
    if (measure(candidate) <= availableWidth) {
      return candidate
    }
  }

  return segments.at(-1) ?? label
}
