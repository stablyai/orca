declare const detachedStringBrand: unique symbol

/** A string proven free of SlicedString/ConsString parent retention. */
export type DetachedString = string & { readonly [detachedStringBrand]: true }

/** Below this V8 copies instead of building a parent-retaining rope. */
const V8_ROPE_MIN_LENGTH = 13

/** Break V8 rope parent retention by forcing a fresh flat string. */
export function detachString(value: string): DetachedString {
  if (value.length < V8_ROPE_MIN_LENGTH) {
    return value as DetachedString
  }
  // Slicing a ConsString flattens it, so the result's only parent is that fresh
  // copy; `.slice(0)`, `String(v)` and `.repeat(1)` do NOT — see detached-string.test.ts.
  return ` ${value}`.slice(1) as DetachedString
}

/** The detached empty string, for initialising retained-tail state. */
export const EMPTY_DETACHED_STRING = '' as DetachedString
