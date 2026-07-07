/**
 * Pin subprocess message language to English (LC_MESSAGES=C) while keeping
 * the caller's character encoding. LC_ALL=C would also force LC_CTYPE to
 * ASCII, breaking UTF-8 in child processes such as user-authored git hooks.
 * The dropped LC_ALL moves to LC_CTYPE — the one category it governed that
 * must survive, even when LANG is `C`/`POSIX` beside a UTF-8 LC_ALL.
 */
export function withEnglishMessageLocale(env: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  const { LC_ALL, ...rest } = env
  return {
    ...rest,
    ...(LC_ALL ? { LC_CTYPE: LC_ALL } : {}),
    LC_MESSAGES: 'C'
  }
}
