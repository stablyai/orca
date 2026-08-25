/**
 * Branch-name rules mirroring `git check-ref-format --branch`, shared by the
 * renderer (so the picker can disable "Create" and say why before spending a
 * round trip) and by every host entrypoint (defense in depth — the relay is
 * reachable independently of the RPC schema).
 */

export type GitBranchNameRejection =
  | 'empty'
  | 'leading-dash'
  | 'invalid-characters'
  | 'invalid-path-component'
  | 'reserved'

export type GitBranchNameCheck = { ok: true } | { ok: false; reason: GitBranchNameRejection }

/** Tokens git reserves for revision syntax. */
const FORBIDDEN_PUNCTUATION = '~^:?*[\\'

/**
 * Why a scan and not a regex: the forbidden set is mostly control characters,
 * and a regex literal spelling them out trips `no-control-regex`.
 */
function hasForbiddenCharacter(branch: string): boolean {
  for (const character of branch) {
    const code = character.codePointAt(0) ?? 0
    if (code <= 0x20 || code === 0x7f || FORBIDDEN_PUNCTUATION.includes(character)) {
      return true
    }
  }
  return false
}

export function checkGitBranchName(branch: string): GitBranchNameCheck {
  if (branch.length === 0) {
    return { ok: false, reason: 'empty' }
  }
  // Why: a leading dash is the flag-injection vector, not merely an invalid ref.
  if (branch.startsWith('-')) {
    return { ok: false, reason: 'leading-dash' }
  }
  if (branch === '@') {
    return { ok: false, reason: 'reserved' }
  }
  if (hasForbiddenCharacter(branch) || branch.includes('..') || branch.includes('@{')) {
    return { ok: false, reason: 'invalid-characters' }
  }
  if (
    branch.startsWith('/') ||
    branch.endsWith('/') ||
    branch.includes('//') ||
    branch.endsWith('.')
  ) {
    return { ok: false, reason: 'invalid-path-component' }
  }
  for (const component of branch.split('/')) {
    if (component.startsWith('.') || component.endsWith('.lock')) {
      return { ok: false, reason: 'invalid-path-component' }
    }
  }
  return { ok: true }
}

export function isValidGitBranchName(branch: string): boolean {
  return checkGitBranchName(branch).ok
}

/**
 * Throw on any name git would reject. Callers that accept a name git itself
 * produced (an existing branch being checked out) still pay this so a corrupted
 * or hostile ref list cannot smuggle a flag through.
 */
export function assertValidGitBranchName(branch: string): void {
  if (!isValidGitBranchName(branch)) {
    throw new Error('invalid_branch_name')
  }
}
