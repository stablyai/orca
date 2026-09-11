const SPEC_BASENAME_RE = /\.(spec|test)\.[^.]+$/i

// Why: keep the outline off untitled drafts and non-test code to bound parse cost and panel noise.
/**
 * Returns whether a relative file path represents a supported TypeScript or JavaScript test specification.
 */
export function isTestSpecFile(relativePath: string, resolvedLanguage: string): boolean {
  if (resolvedLanguage !== 'typescript' && resolvedLanguage !== 'javascript') {
    return false
  }
  const parts = relativePath.split(/[\\/]/)
  const basename = parts.at(-1) ?? ''
  return SPEC_BASENAME_RE.test(basename)
}
