/** Pin English Git diagnostics/progress (#7808), including gettext’s higher-priority LANGUAGE, or localized fatal prefixes break parsing.
 * Use English UTF-8 for hook LC_CTYPE; hosts lacking en_US.UTF-8 fall back to untranslated C. */
export const UNTRANSLATED_GIT_OUTPUT_ENV = {
  LANGUAGE: 'en',
  LC_ALL: 'en_US.UTF-8',
  LANG: 'en_US.UTF-8'
} as const
