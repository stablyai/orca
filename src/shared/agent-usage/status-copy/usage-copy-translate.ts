import type { TOptions } from 'i18next'

/** Desktop and mobile each pass their own translator, so the copy resolves in that surface's catalog. */
export type UsageCopyTranslate = (key: string, fallback: string, options?: TOptions) => string
