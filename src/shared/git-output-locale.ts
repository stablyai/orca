/**
 * Env pinning git subprocess output to untranslated English (issue #7808).
 *
 * Why: Orca parses git's stderr diagnostics and progress lines (e.g.
 * isNoUpstreamError, clone progress/`fatal:` matching); a gettext-enabled git
 * under a non-English locale translates even the `fatal:` prefix and silently
 * breaks those parsers. An English UTF-8 locale rather than plain `C` keeps a
 * UTF-8 LC_CTYPE for hooks git spawns (commit, push); a host without
 * en_US.UTF-8 falls back to C, which still emits untranslated messages.
 * LANGUAGE outranks LC_ALL in gettext's lookup, so it is pinned too.
 */
export const UNTRANSLATED_GIT_OUTPUT_ENV = {
  LANGUAGE: 'en',
  LC_ALL: 'en_US.UTF-8',
  LANG: 'en_US.UTF-8'
} as const
