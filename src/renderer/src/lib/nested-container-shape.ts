/**
 * Shape classification for the nested collection size walker.
 *
 * Keeps exotic objects out, classifies dictionary keys, and gates labels to a
 * source-owned vocabulary before crash reports leave the machine.
 */

/** Entries sampled to decide dictionary-vs-struct; shape is uniform, so few suffice. */
export const HOMOGENEITY_SAMPLE = 8

/**
 * Strict lowerCamelCase distinguishes likely fields from common user-key shapes.
 * The source-owned vocabulary below is the final authorization boundary.
 */
const NAMED_PROPERTY_KEY = /^[a-z][A-Za-z0-9]{0,31}$/

export function isFieldNameShaped(key: string): boolean {
  return NAMED_PROPERTY_KEY.test(key)
}

/**
 * Only source-owned literals may cross the crash-report privacy boundary.
 * Runtime shape checks cannot distinguish `stateHistory` from a user-chosen
 * camelCase repo name, so they are defense in depth rather than authorization.
 */
const APPROVED_PATH_FIELD_NAMES = new Set([
  'branches',
  'browserUrlHistory',
  'byPane',
  'cache',
  'child',
  'comments',
  'dictionary',
  'diffComments',
  'entries',
  'files',
  'history',
  'items',
  'list',
  'panes',
  'settings',
  'stateHistory',
  'tabs'
])

export function isApprovedPathFieldName(key: string): boolean {
  return APPROVED_PATH_FIELD_NAMES.has(key)
}

/** Anything whose entries we can count: containers, plus Sets (counted, not entered). */
export function isCountableContainer(value: unknown): boolean {
  return isSetContainer(value) || isWalkableContainer(value)
}

/** True for containers safe to iterate: arrays, Maps, and plain objects. */
export function isWalkableContainer(value: unknown): value is object {
  return isArrayContainer(value) || isMapContainer(value) || isPlainObjectShape(value)
}

export function isArrayContainer(value: unknown): value is unknown[] {
  return Array.isArray(value) && Object.getPrototypeOf(value) === Array.prototype
}

export function isMapContainer(value: unknown): value is Map<unknown, unknown> {
  return value instanceof Map && Object.getPrototypeOf(value) === Map.prototype
}

export function isSetContainer(value: unknown): value is Set<unknown> {
  return value instanceof Set && Object.getPrototypeOf(value) === Set.prototype
}

export function isReportableContainer(value: object, size: number, maxStructKeys: number): boolean {
  return (
    isArrayContainer(value) ||
    isMapContainer(value) ||
    isSetContainer(value) ||
    size > maxStructKeys
  )
}

/**
 * Plain data objects only. Class instances (xterm Terminals, React fibers, DOM
 * nodes, Promises, typed arrays, Zustand stores) fail the prototype test and are
 * never entered, which is what keeps huge fan-out and getter side effects out.
 */
export function isPlainObjectShape(value: unknown): boolean {
  if (typeof value !== 'object' || value === null) {
    return false
  }
  const prototype = Object.getPrototypeOf(value)
  if (prototype !== Object.prototype && prototype !== null) {
    return false
  }
  // Avoid invoking accessors while excluding prototype-plain React/DOM shapes.
  return !Object.hasOwn(value, '$$typeof') && !Object.hasOwn(value, 'nodeType')
}

/**
 * Distinguishes a dictionary from a struct by whether its ENTRIES REPEAT A
 * SHAPE, because key count alone cannot: a user with three repos has a
 * three-key dictionary whose keys are repo names, and those keys would
 * otherwise be uploaded to Slack verbatim.
 *
 * A dictionary's values are interchangeable records — two or more plain objects
 * with the same field names (`{[repo]: {branches}}`). A struct's fields are not
 * (`{paneKey, state, stateHistory}` mixes scalars with an array; `{tabs, panes}`
 * holds arrays, which carry no field names to match). Erring toward "dictionary"
 * costs grouping precision; the fixed vocabulary still prevents raw-key leaks.
 */
export function hasRepeatedEntryShape(container: object, isExpired?: () => boolean): boolean {
  let signature: string | null = null
  let sampled = 0
  try {
    for (const key in container) {
      // Why checked per entry: each one costs a for-in over a value that may be
      // huge, so the cap alone bounds the entry COUNT but not the time. Bailing
      // returns `true`, which collapses keys — the privacy-safe direction.
      if (sampled >= HOMOGENEITY_SAMPLE) {
        break
      }
      if (isExpired?.() === true) {
        return true
      }
      const descriptor = Object.getOwnPropertyDescriptor(container, key)
      if (descriptor === undefined || !('value' in descriptor)) {
        return true
      }
      const value = descriptor.value
      // Why plain objects only: arrays and Maps expose no field names, so a
      // struct of arrays is indistinguishable from a dictionary of arrays.
      if (!isPlainObjectShape(value)) {
        return false
      }
      const entrySignature = fieldSignature(value as object, isExpired)
      if (entrySignature === null) {
        return true
      }
      if (signature === null) {
        signature = entrySignature
      } else if (signature !== entrySignature) {
        return false
      }
      sampled += 1
    }
  } catch {
    // Why: an unreadable entry proves nothing about shape; treat keys as data.
    return true
  }
  // One entry cannot demonstrate repetition.
  return sampled >= 2
}

/**
 * True when EVERY sampled key looks like a field name, not just the one being
 * labelled.
 *
 * Why sibling-wide: a lone key is weak evidence, because user data can be
 * accidentally camelCase — a branch named `myFeature`, a repo named `orcaWeb`.
 * Siblings are what give it away: real branch and repo sets almost always
 * contain at least one `feature/x`, `fix-y`, or `snake_name`, and one such
 * sibling now condemns the whole container's keys instead of only itself.
 */
export function hasOnlyFieldNameShapedKeys(container: object, isExpired?: () => boolean): boolean {
  let sampled = 0
  try {
    for (const key in container) {
      if (sampled >= HOMOGENEITY_SAMPLE) {
        break
      }
      if (isExpired?.() === true) {
        return false
      }
      if (!isFieldNameShaped(key)) {
        return false
      }
      sampled += 1
    }
  } catch {
    return false
  }
  return true
}

/**
 * Field names of one entry, order-independent.
 *
 * Why for-in rather than Object.keys: it avoids a key array proportional to an
 * entry that may already be consuming the renderer heap.
 */
function fieldSignature(entry: object, isExpired?: () => boolean): string | null {
  const fields: string[] = []
  for (const key in entry) {
    if (isExpired?.() === true) {
      return null
    }
    if (fields.length >= HOMOGENEITY_SAMPLE) {
      break
    }
    fields.push(key)
  }
  return fields.sort().join(',')
}
