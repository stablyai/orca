import { z } from 'zod'

/**
 * Structural validation for the globs a `files:read` capability declares.
 * Electron-free and matcher-free by design: Phase 1 owns the shape of a declared
 * pattern at manifest-validation time — the character allowlist and the segment and
 * construct refusals below — while matching semantics, the dialect and the
 * credential denylist belong to a later phase (D-04). Nothing here touches a
 * filesystem.
 */

// Why: mirrors bounds the manifest already uses — `capabilities` is capped in
// plugin-manifest.ts and short manifest fields in plugin-manifest-fields.ts.
export const PLUGIN_CAPABILITY_PATH_LIMIT = 32
export const PLUGIN_CAPABILITY_PATH_MAX_LENGTH = 256

const WINDOWS_DRIVE_PREFIX_RE = /^[A-Za-z]:/
// Two leading backslashes: a UNC share root, absolute without a drive letter.
const UNC_PREFIX_RE = /^\\\\/
const LEADING_SEPARATOR_RE = /^[\\/]/
const PATH_SEPARATOR_RE = /[\\/]/
const UNSUPPORTED_METACHARACTER_RE = /[?{}[\]]/

/**
 * Declared limits of the accepted pattern set — a boundary decision, recorded here
 * so a later phase reads it as a decision rather than as an oversight.
 *
 * This is an allowlist, not a denylist. It accepts exactly: ASCII letters, ASCII
 * digits, the dot, the underscore, the hyphen, the forward slash and the asterisk.
 *
 * It therefore deliberately refuses every other glob-dialect construct — the
 * extglob openers, the vertical bar, and the backslash in any position — along
 * with every non-ASCII code point, every C0/C1 control character, every
 * bidirectional and format control, and every whitespace character.
 *
 * Non-ASCII is refused rather than normalised because refusing removes the
 * normalisation question entirely instead of answering it: two patterns a user
 * cannot tell apart on screen are a consent-integrity problem, not an encoding
 * problem, and no normalisation rule makes them distinguishable.
 *
 * Under this set every accepted character is exactly one UTF-16 code unit, so
 * PLUGIN_CAPABILITY_PATH_MAX_LENGTH is an exact character count for any pattern
 * that validates.
 *
 * Why an allowlist (D-04): Phase 2 can loosen this safely, because loosening never
 * refuses a manifest already accepted. Tightening a denylist after third-party
 * manifests exist is what stops a plugin loading on upgrade.
 *
 * Phase 2 owns any loosening (SCOPE-02, D-05). A construct Phase 2's matcher
 * dialect needs is a declared boundary here, not an open gap.
 *
 * plugin-path-safety.ts was evaluated for reuse and is not reused: its
 * WINDOWS_FORBIDDEN_CHAR_RE refuses the asterisk, so calling it on a glob would
 * refuse `**`, the whole-worktree form this feature is specified in terms of.
 */
const ALLOWED_PATTERN_CHARS_RE = /^[A-Za-z0-9._\-/*]+$/

/**
 * Returns the first violated rule's message, or null when the pattern is
 * structurally acceptable. Both the emptiness and the length bound are checks of
 * this predicate rather than of the schema wrapping it, so it stays honest when
 * called directly — zod 4 accumulates issues across a `.max().superRefine()`
 * chain instead of aborting it, so the schema's own bound cannot be relied on to
 * shield the refinement from an unbounded input.
 *
 * Every rule is linear with no nested quantifiers, which is the ReDoS mitigation;
 * the length guard bounds the input before any regex runs.
 */
export function pluginCapabilityPathError(value: string): string | null {
  if (value.length === 0) {
    return 'must not be empty'
  }
  if (value.length > PLUGIN_CAPABILITY_PATH_MAX_LENGTH) {
    return `must be at most ${PLUGIN_CAPABILITY_PATH_MAX_LENGTH} characters`
  }
  if (WINDOWS_DRIVE_PREFIX_RE.test(value) || UNC_PREFIX_RE.test(value)) {
    return 'must not be an absolute path'
  }
  if (LEADING_SEPARATOR_RE.test(value)) {
    return 'must not start with a path separator (paths are relative to the worktree root)'
  }
  // Why: split on both separators and compare whole segments — a bare ".." substring
  // test would also refuse the legitimate filename foo..bar.
  const segments = value.split(PATH_SEPARATOR_RE)
  if (segments.includes('..')) {
    return 'must not contain a ".." segment'
  }
  // Why: one grant spelled several ways ('docs/**', './docs/**', 'docs//**') would
  // consume several budget slots and render as several identical-looking consent rows.
  if (segments.some((segment) => segment.length === 0 || segment === '.')) {
    return 'must not contain an empty or "." path segment'
  }
  if (
    ALLOWED_PATTERN_CHARS_RE.test(value) &&
    segments.some((segment) => segment.includes('**') && segment !== '**')
  ) {
    return 'must use "**" only as a complete path segment'
  }
  // Why the two constructs get their own messages: D-04 names negation and alternation
  // by name, so the author is told which one they used rather than reading a character list.
  if (value.includes('!')) {
    return 'must not use a negation pattern'
  }
  if (value.includes('|')) {
    return 'must not use an alternation pattern'
  }
  if (UNSUPPORTED_METACHARACTER_RE.test(value)) {
    return 'must not use "?", "{}" or "[]"'
  }
  if (!ALLOWED_PATTERN_CHARS_RE.test(value)) {
    return 'must use only letters, digits, ".", "_", "-", "/" and "*"'
  }
  return null
}

export function isSafePluginCapabilityPath(value: string): boolean {
  return pluginCapabilityPathError(value) === null
}

// Why superRefine over refine: the author learns which rule the pattern broke
// instead of one static message. Element refinements run before the array
// transform below, so a refusal names the pattern's index as it was written.
export const pluginCapabilityPathSchema = z
  .string()
  .min(1)
  .max(PLUGIN_CAPABILITY_PATH_MAX_LENGTH)
  .superRefine((value, ctx) => {
    const error = pluginCapabilityPathError(value)
    if (error !== null) {
      ctx.addIssue({ code: 'custom', message: error })
    }
  })

// Why here and not in canonicalizeCapabilitySet (D-06): that function is shared by
// every consent path, it dedupes whole encoded objects but never array values, and
// changing it is precisely the failure CAP-06 exists to detect.
// Why the array's default comparator: it is UTF-16 code-unit order. A locale-aware
// collator is ICU-build-dependent, so a fingerprint built on one can differ between
// a full-ICU and a small-ICU Node build and re-prompt a user nobody touched.
export const pluginCapabilityPathsSchema = z
  .array(pluginCapabilityPathSchema)
  .min(1)
  .max(PLUGIN_CAPABILITY_PATH_LIMIT)
  .transform((paths) => [...new Set(paths)].sort())
