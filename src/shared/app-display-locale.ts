// THE APP LOCALE CONTRACT for machine-composed display strings.
//
// The problem this exists to prevent: `new Intl.DateTimeFormat(undefined, ...)`
// and `Number.prototype.toLocaleString()` with no argument inherit the HOST OS
// locale. On a ru-RU machine that produced `воскресеньеs at 12:30` — a Russian
// weekday with an English plural `s` welded on — and `more than 10 000 jobs`
// with a U+00A0 group separator, inside strings whose surrounding words are
// hardcoded English.
//
// THE RULE:
//
//   A fragment interpolated into a hardcoded-English sentence must be formatted
//   in English. A value the user reads as a standalone quantity or clock time
//   follows the user's own conventions.
//
// So this module deliberately exposes TWO things, not one. Collapsing them would
// trade one bug for another: forcing everything to en-US would show a 12-hour
// clock to users whose locale uses 24-hour time, and leaving everything host-
// derived reproduces the mixed-language bug.
//
// SCOPE. This is about strings the app COMPOSES from literals. It has nothing to
// do with the renderer's i18n catalog: a string that goes through `translate()`
// is already localized as a whole sentence and must NOT use this module.

/**
 * The locale for fragments embedded in hardcoded-English sentences.
 *
 * `en-US` rather than `en` because it also fixes number grouping (`10,000`, not
 * `10 000`), which several `en-*` locales format differently. Matches the
 * explicit `'en-US'` already passed at 11 call sites, e.g.
 * worktree-include-copy-budget.ts.
 */
export const APP_ENGLISH_LOCALE = 'en-US'

/**
 * Formats a weekday name for interpolation into an English label.
 *
 * Used where the caller then appends English text — `${day}s at ${time}` — so a
 * host-locale weekday would produce a mixed-language string.
 */
export function formatEnglishWeekday(date: Date): string {
  return new Intl.DateTimeFormat(APP_ENGLISH_LOCALE, { weekday: 'long' }).format(date)
}

/**
 * Formats an integer count for interpolation into an English sentence.
 *
 * Explicitly locale-pinned so the group separator is a comma on every host —
 * error messages and limits are matched against by tests and read by support.
 */
export function formatEnglishCount(value: number): string {
  return value.toLocaleString(APP_ENGLISH_LOCALE)
}

/**
 * Formats a clock time using the USER'S locale, deliberately.
 *
 * NOT pinned to English: 12-hour vs 24-hour is a genuine user-facing preference,
 * and unlike a weekday this value is read as a standalone quantity rather than
 * grammatically joined to English words. Kept here so the deliberate `undefined`
 * is documented at the contract boundary rather than looking like the very
 * oversight this module fixes.
 */
export function formatHostClockTime(date: Date): string {
  return new Intl.DateTimeFormat(undefined, { hour: 'numeric', minute: '2-digit' }).format(date)
}
