/** Substituted by electron.vite.config.ts; absent in the CLI and web client. Unit tests run with DEV on. */
declare const ORCA_STORE_CHANNELS: 'root' | 'main' | undefined

/** Channel-only writes skip root selectors in development and in ORCA_STORE_CHANNELS=main dark builds. */
export const ORCA_STORE_CHANNELS_SKIP_ROOT_SELECTORS =
  import.meta.env.DEV ||
  // oxlint-disable-next-line unicorn/no-typeof-undefined -- undeclared outside electron-vite builds; a bare read throws.
  (typeof ORCA_STORE_CHANNELS !== 'undefined' && ORCA_STORE_CHANNELS === 'main')
