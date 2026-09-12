const MAX_PACKAGE_NAME_LENGTH = 214
/** A single scope or name segment: lowercase-start, no leading `.`/`_`/`-`. */
const SEGMENT_PATTERN = /^[a-z0-9][a-z0-9._-]*$/
const SCOPED_NAME_PATTERN = /^@([^/]+)\/([^/]+)$/

/**
 * Strict npm package name validation, applied before a name becomes argv for
 * `npm view` or a URL path segment for the registry HTTP fallback. Deliberately
 * stricter than npm's own `validate-npm-package-name` (e.g. a leading `-` is
 * rejected here even though it is not banned by the registry) because a
 * leading `-` would be parsed as a CLI flag by `runProcess`'s argv.
 */
export function isValidNpmPackageName(name: string): boolean {
  if (typeof name !== 'string' || name.length === 0 || name.length > MAX_PACKAGE_NAME_LENGTH) {
    return false
  }
  if (name !== name.toLowerCase()) {
    return false
  }

  const scopedMatch = name.match(SCOPED_NAME_PATTERN)
  if (scopedMatch) {
    const [, scope, packageName] = scopedMatch
    return SEGMENT_PATTERN.test(scope) && SEGMENT_PATTERN.test(packageName)
  }
  if (name.includes('/')) {
    return false
  }
  return SEGMENT_PATTERN.test(name)
}
