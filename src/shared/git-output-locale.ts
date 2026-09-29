/**
 * Env pinning git subprocess output to untranslated English (issue #7808)
 * without pinning LC_CTYPE to UTF-8.
 *
 * Why English: Orca parses git's stderr diagnostics and progress lines (e.g.
 * isNoUpstreamError, clone progress/`fatal:` matching); a gettext-enabled git
 * under a non-English locale translates even the `fatal:` prefix and silently
 * breaks those parsers.
 *
 * Why not LC_ALL=en_US.UTF-8: LC_ALL also pins LC_CTYPE, and under a UTF-8
 * LC_CTYPE macOS libc reports isspace(0xA0) (NBSP) as true. Git's
 * shorten_unambiguous_ref() parses with sscanf("%s"), which stops at the first
 * byte libc calls whitespace -- so a branch name whose UTF-8 encoding contains
 * 0xA0 (`渠` is E6 B8 A0) gets cut mid-sequence and every abbreviated form
 * (`%(refname:short)`, `%(upstream:short)`, `rev-parse --abbrev-ref`,
 * `symbolic-ref --short`) returns a truncated, invalidly-encoded name.
 * LC_MESSAGES alone keeps the English diagnostics with a C LC_CTYPE.
 *
 * LC_ALL is emptied rather than omitted because it outranks LC_MESSAGES and
 * LC_CTYPE, so a user who exports it would otherwise reinstate the UTF-8
 * LC_CTYPE; an empty value is ignored by setlocale, unlike an inherited one.
 * LC_CTYPE is then pinned explicitly rather than left to fall back through
 * LANG, because an empty LC_ALL resolves to C on macOS but defers to LANG under
 * glibc. LANGUAGE outranks LC_ALL in gettext's lookup, so it is pinned too, and
 * LANG stays English for hosts that consult it first.
 *
 * A C LC_CTYPE costs nothing here: git emits ref and path bytes verbatim
 * regardless of locale, and commit messages Orca passes to git stay byte-exact.
 */
export const UNTRANSLATED_GIT_OUTPUT_ENV = {
  LANGUAGE: 'en',
  LC_ALL: '',
  LC_MESSAGES: 'en_US.UTF-8',
  LC_CTYPE: 'C',
  LANG: 'en_US.UTF-8'
} as const
